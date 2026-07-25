# Freebird 0.8.9 — BYOK is now free, and we fixed the edit counter

**TL;DR: If your free edits seemed to run out way too fast — you were right. Fixed. And bring-your-own-key no longer needs Pro.**

## The bug, honestly

A leftover client-side counter was capping the smooth free experience at **5 edits/day**, even though the free tier is — and was always advertised as — **20/day**. Worse, after edit 5 it silently rerouted you through an Ollama fallback, which meant "Ollama is not reachable" warnings for people who never installed Ollama. If you saw "4 free edits left" after your very first edit, that was this bug.

As of 0.8.9 the server is the single source of truth: you get your full 20/day, the counter in the UI is the real one, and you'll only ever see Ollama messages if you actually use Ollama.

## BYOK is now free — for everyone

Bring-your-own-key backends — **Anthropic Claude, OpenAI, DeepSeek, Qwen** — no longer require Pro. Your key, your machine, your calls; they never touch our servers, so we're not going to charge you for them. Local **Ollama** stays free and unlimited too.

## So what's Pro?

Pro is the stuff that runs on our infrastructure:

- **Agent mode** — multi-file edits, terminal commands, checkpoints, project memory
- **Unlimited cloud edits** on the full Gemini Flash model (free tier runs the lite variant)

**$6/month, with a 7-day free trial — no card required.** Sign in with GitHub and you're in.

Thanks to everyone who reported weirdness with the edit counter — you were seeing a real bug, and this release exists because you flagged it.

— Ten Labs
