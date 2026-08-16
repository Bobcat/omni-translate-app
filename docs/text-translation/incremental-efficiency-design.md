# Efficient incremental text translation

Status: research and design proposal. No implementation is implied by this document.

## Decision summary

The first implementation should reduce unnecessary full-text requests without
changing translation semantics. It should:

- normalize only trailing whitespace in the submitted text;
- suppress requests whose semantic input has not changed;
- wait until IME composition has finished;
- avoid an immediate request chain when text changes during inference;
- translate pasted text, language changes, and explicit keyboard submission
  immediately;
- translate ordinary typing after a short idle period;
- keep the existing full-text translation response.

Do not start with sentence-level translation reuse. Later context can change an
earlier sentence. A safe incremental design needs an explicit context policy,
stable segment identities, invalidation rules, and a mutable tail.

## Goals

- Reduce LLM requests generated while a user types.
- Reduce repeated prefill and output generation for unchanged text.
- Keep the final translation at least as good as the current full-text result.
- Keep displayed results consistent with the newest source text.
- Produce enough metrics to decide whether segment reuse is worth building.

## Non-goals

- Redesign the text translation UI.
- Add saved translations or a translation memory product.
- Change PDF, image, or voice translation.
- Persist source text or translations for observability.
- Commit to sentence-level reuse before it has been evaluated by language pair.

## Current request flow

The desktop text view uses a 350 ms debounce and a 1,750 ms ceiling. It allows
one request in flight. When input changes during that request, the runner starts
another request immediately after the first finishes.

Every request contains the complete source text:

```text
browser
  -> POST /api/text-translation
  -> app admission and exact-payload success cache
  -> POST translation-services /v1/translate
  -> split into chunks of at most 2,000 characters
  -> one llm-pool request per chunk
  -> concatenate translated chunks
```

Relevant app code:

- [desktop text view](../../static/desktop/src/views/text/index.js)
- [desktop request runner](../../static/desktop/src/views/text/translation-runner.js)
- [app API client](../../static/desktop/src/shared/api.js)
- [app text route](../../app/router.py)
- [admission and success cache](../../app/text_translation_policy.py)
- [translation-services bridge](../../app/translation_bridge.py)

Translation-services currently owns profile selection, prompts, model routing,
chunking, and llm-pool calls. Its relevant files are:

```text
app/routes/text_translation.py
app/translation/text/service.py
config/settings.json -> text_translation.profiles
```

The current translation-services chunker removes whitespace at the start and
end of the complete source. It also trims each chunk at its boundaries. The app
does not normalize before enforcing its limit or computing its cache key.
Consequently, `Hallo`, `Hallo `, and `Hallo\n` use different app cache entries,
although the LLM receives equivalent text.

## Sources of avoidable work

### Trailing whitespace

Spaces and line breaks at the end do not add translation context. They should
not trigger a request. The textarea must retain them, because submission
normalization should never rewrite what the user is editing.

### Duplicate semantic input

The browser currently lacks a semantic request key. The same source and
language pair can therefore be scheduled again even when only disposable
trailing whitespace changed.

### Continuous typing

The ceiling causes periodic translation while the user keeps typing. During a
slow request, further edits mark the runner dirty. Completion then triggers the
next full-text request immediately. One active typist can therefore keep the
model busy with intermediate states that are never read.

### IME composition

Input methods for languages such as Chinese and Japanese emit intermediate
input states while a character is still being composed. Those states should
not be translated.

### Stale results

A result belongs to the exact source and language pair sent with its request.
It must not replace the target text after that semantic input has changed.

### Long input

Translation-services splits text above 2,000 characters into independent
chunks. When the user appends to a long text, completed prefix chunks may be
identical to those in the preceding request. They are nevertheless sent to the
LLM again.

## Phase 1: safe app-only dispatch reduction

### Canonical submitted text

Derive a submitted form without changing the textarea:

1. normalize `CRLF` and bare `CR` to `LF`;
2. remove whitespace only from the end;
3. preserve leading whitespace, internal spacing, and internal blank lines.

Use this value consistently for:

- minimum-length checks;
- the request body;
- freshness checks;
- duplicate suppression;
- app-side maximum-length checks and usage accounting when those are added.

Do not collapse internal whitespace. It may represent paragraphs, tables,
poetry, code, or other meaningful layout.

### Semantic request key

Compute a key over:

```text
source language + target language + canonical submitted text
```

Track three keys in the browser:

- scheduled key;
- in-flight key;
- last successful key.

Do not dispatch when the candidate key matches any work that already satisfies
the current UI state. A language change necessarily creates a new key.

### Timing policy

Recommended initial policy:

| User action | Dispatch |
|---|---|
| Ordinary typing | 500–650 ms after the last semantic edit |
| Paste | Immediately after the paste event settles |
| Source or target language change | Immediately |
| Swap languages | Immediately |
| Ctrl/Cmd+Enter | Immediately |
| IME composition update | Never |
| IME composition end | Apply ordinary typing policy |
| Trailing whitespace only | Never |

Remove the periodic 1,750 ms ceiling initially. A user who types continuously
gets one request after a short pause instead of repeated intermediate runs.
The exact idle delay should remain a named frontend policy constant.

### Changes during inference

When input changes during an in-flight request:

1. mark that result stale immediately;
2. do not display it when it returns;
3. do not start another request directly from `finally`;
4. begin a new idle timer from the latest semantic edit;
5. dispatch only the newest key when both the request slot and idle policy
   allow it.

This preserves one-in-flight behavior without creating a continuous request
chain.

### Backend normalization

The app route should repeat canonicalization before limit enforcement, hashing,
and upstream submission. Frontend normalization reduces traffic but is not a
trust boundary. Backend normalization also keeps desktop, future mobile, and
direct API callers consistent.

The success cache remains scoped to the principal. Its key should use the
canonical text and normalized language identifiers.

## Phase 2: measurement

Measure this phase before designing incremental reuse. Record counts and sizes,
not source or translated content.

Suggested events and fields:

| Metric | Purpose |
|---|---|
| semantic input changes | Denominator for dispatch reduction |
| requests scheduled | Shows timing-policy pressure |
| requests dispatched | Actual app and service load |
| duplicate requests suppressed | Value of semantic keys |
| trailing-only changes suppressed | Value of canonicalization |
| IME updates suppressed | Avoided invalid partial input |
| stale completions discarded | Wasted completed inference |
| dirty changes coalesced | Work avoided while inference ran |
| canonical input characters | Request-size distribution |
| llm-pool prompt tokens | Prefill volume |
| llm-pool cached prompt tokens | Prefix-cache effectiveness |
| llm-pool output tokens | Decode volume |
| end-to-end and backend wall time | User latency and GPU occupancy |

Aggregate by profile, model, source language, target language, and anonymous or
authenticated principal class. Do not log principal identifiers in general
metrics unless an existing protected operations surface requires them.

### Prefix-cache observability gap

The selected E4B model runs through `vllm_serve`. Current vLLM enables automatic
prefix caching by default. Appending source text can therefore reuse part of an
unchanged prompt prefix during prefill.

This does not reuse the prior translation. Output tokens are generated again.
It also does not remove HTTP, scheduling, or request bookkeeping.

The llm-pool vLLM adapter currently reads total prompt and output token counts,
but not `usage.prompt_tokens_details.cached_tokens`. Before drawing conclusions
about prefix caching, expose that value as `engine_cached_prompt_tokens` and
confirm the effective runtime setting. This is llm-pool work, not part of the
app-only first phase.

## Why naive sentence reuse is unsafe

An earlier sentence can change when a later sentence supplies:

- grammatical gender;
- the referent of a pronoun;
- word-sense disambiguation;
- terminology or topic;
- tone and register;
- quotation or discourse structure.

A small local probe against the currently running fast E4B profile demonstrated
this behavior. This is an illustrative probe, not a quality benchmark.

| Source | Translation without later context | Translation with later context |
|---|---|---|
| `The teacher entered the room.` to French | `Le professeur entra...` | After `She put her handbag...`: `La maîtresse entra...` |
| `I met my friend at the station.` to German | `Ich traf meinen Freund...` | After `She wore...`: `Ich traf meine Freundin...` |
| `Hij zat op de bank.` to English | `He was sitting on the couch.` | With a following sentence: `He sat on the couch.` |

Exact sentence text is therefore not a sufficient cache key. Adding the later
sentence can make an earlier cached translation obsolete.

Sentence boundary detection does not solve this. Locale-aware segmentation is
useful, but sentence boundaries remain ambiguous around abbreviations, numbers,
quotes, and language-specific punctuation.

## Phase 3: exact translation-services chunk cache

The current service already translates its 2,000-character chunks without
cross-chunk context. Exact reuse of an unchanged chunk therefore introduces no
new context loss relative to current behavior.

A bounded success-cache could key each chunk by:

```text
profile id and version
+ model id
+ rendered instructions
+ source language
+ target language
+ exact chunk text
+ decoding settings
```

Only successful, complete output may be cached. Empty or token-limited output,
backend errors, and interrupted calls must not be cached.

The cache needs:

- a byte or entry bound;
- a short configurable TTL;
- invalidation through profile and model version fields in the key;
- metrics for hit rate, saved prompt tokens, and saved output tokens;
- a documented privacy and isolation policy.

Principal isolation is the safest initial policy. Cross-principal reuse can
save more work for common phrases, but it turns user text into shared retained
state and requires a separate privacy decision.

Chunk caching mainly helps input longer than one chunk. It does little for the
common short-text typing case, where Phase 1 request reduction matters more.

## Phase 4: contextual incremental translation experiment

Segment reuse needs a service-owned protocol. The browser should not splice
translations based on punctuation or guess which previous output remains valid.

### Mutable-tail model

Represent a document as:

```text
[committed segments] [mutable context window] [unfinished source tail]
```

The service may reuse committed output. It retranslates the mutable window when
new context arrives. A starting experiment could keep the last two complete
sentences plus the unfinished sentence mutable.

This number is not a product default. It must be measured per important
language direction.

### Required ownership

Translation-services should own:

- locale-aware segmentation;
- stable segment identifiers;
- source revisions;
- context-window selection;
- cache keys and invalidation;
- profile and prompt version binding;
- assembly of the complete target document;
- warnings when a segment remains provisional.

The app should own:

- editor state;
- the current document or edit-session identifier;
- request freshness;
- presentation of provisional versus settled output;
- account ownership and admission.

### Context policy choices

Two policies have different semantics:

**Causal translation**

- A segment may use earlier context only.
- Later text never changes committed output.
- Output is stable and efficient.
- Future clarification can no longer repair an earlier ambiguity.

**Best document translation**

- Later context may revise earlier segments.
- A tail remains provisional.
- Final quality can improve.
- The UI must tolerate controlled revisions.

A useful hybrid may translate only the mutable tail during typing, then perform
one full verification after two or three seconds of real inactivity. The full
run is authoritative. Differences between the incremental assembly and full
run become the central evaluation signal.

### Segment cache key

A contextual segment cache requires more than sentence text:

```text
model/profile/prompt version
+ source and target language
+ exact segment source
+ context policy version
+ relevant preceding context
+ relevant following context
+ document revision boundary
```

Fuzzy matching is out of scope. It can silently preserve the wrong grammar or
terminology and turns the cache into a translation-memory product.

## Evaluation plan

### Replay corpus

Capture synthetic edit traces, not production text. Include:

- steady character-by-character typing;
- bursts followed by pauses;
- paste and replace-all;
- append-only paragraphs;
- edits near the start and middle;
- trailing spaces and line breaks;
- IME composition sequences;
- language swaps during inference;
- inputs crossing the 2,000-character chunk boundary.

### Context challenge set

Cover at least:

- gender revealed by a later sentence;
- ambiguous nouns resolved by topic;
- pronouns and coreference;
- repeated terminology;
- formal versus informal address;
- quotations and dialogue;
- abbreviations and decimal points near apparent sentence boundaries;
- English, Dutch, German, French, Brazilian Portuguese, Chinese, and Japanese.

### Compare three modes

1. current full retranslation;
2. Phase 1 coalesced full retranslation;
3. contextual incremental candidate plus final full verification.

Measure:

- requests per edit session;
- prompt and output tokens;
- cached prompt tokens;
- GPU inference wall time;
- time to first useful translation;
- stale work;
- final output equality or edit distance;
- how many earlier segments change after one, two, and three later sentences;
- targeted human judgments for ambiguity, pronouns, terminology, and fluency.

Do not approve segment reuse from BLEU or character similarity alone. The main
risk is a small grammatical or discourse error in an otherwise similar result.

## Recommended implementation order

1. Build the app-only canonicalization and dispatch coordinator.
2. Add privacy-safe counters and token/timing propagation.
3. Measure real request reduction and stale work.
4. Expose vLLM cached prompt tokens through llm-pool observability.
5. Add exact current-chunk caching in translation-services if long-input traces
   show enough duplicate chunks.
6. Build a contextual segment-reuse prototype behind a disabled experimental
   setting.
7. Compare it against an authoritative full translation before making it
   user-visible.

## Open decisions

- The ordinary typing idle delay: start with 500 or 650 ms.
- Whether the app should ever retain a long typing ceiling after Phase 1.
- Whether exact chunk caching must always be principal-scoped.
- Whether the product prefers causal stability or later-context revisions.
- How long a mutable tail remains provisional.
- Whether a final full verification is required after every settled edit burst.

## References

- Unicode, [Unicode Text Segmentation](https://unicode.org/reports/tr29/).
- MDN, [`Intl.Segmenter`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter).
- vLLM, [Automatic Prefix Caching](https://docs.vllm.ai/en/v0.24.0/api/vllm/config/cache/).
- Herold and Ney, [Improving Long Context Document-Level Machine Translation](https://aclanthology.org/2023.codi-1.15/).
- Lyu et al., [Encouraging Lexical Translation Consistency for Document-Level Neural Machine Translation](https://aclanthology.org/2021.emnlp-main.262/).
- Wong et al., [Contextual Neural Machine Translation Improves Translation of Cataphoric Pronouns](https://aclanthology.org/2020.acl-main.530/).
- Sen et al., [Self-training Reduces Flicker in Retranslation-based Simultaneous Translation](https://aclanthology.org/2023.eacl-main.270/).
- Arivazhagan et al., [Re-translation versus Streaming for Simultaneous Translation](https://aclanthology.org/2020.iwslt-1.27/).
