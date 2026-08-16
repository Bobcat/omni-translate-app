// Sign-in card (DeepL-inspired): short heading, one-line reason and Google's
// own rendered sign-in button. Used by the Account view.

import { renderGoogleButton } from '../auth.js';

export function createSignInCard(reason) {
  const card = document.createElement('div');
  card.className = 'signin-card';
  card.innerHTML = `
    <p class="signin-card-reason"></p>
    <h3 class="signin-card-title">Sign in or create an account</h3>
    <div class="google-signin-holder"></div>
  `;
  card.querySelector('.signin-card-reason').textContent = reason;
  renderGoogleButton(card.querySelector('.google-signin-holder'));
  return card;
}
