"""Domain-free SaaS control layer: principals, entitlements, quota, usage.

Extractable by design (plan/phase-1-repository-mapping.md): this package
knows nothing about translations, images or PDFs. Host apps register plans,
entitlement keys and metrics, and adapt their own job flows to it. Keep it
that way — no translation vocabulary in this package.
"""
