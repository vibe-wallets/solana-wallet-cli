# Repository migration verification

## Goal

Verify push access and Docker CI/image publishing on
`vibe-wallets/solana-wallet-cli`, then switch launcher and current documentation
to the new image namespace only after successful verification.

## Progress

- Clean starting checkout at `62bbe51`; origin already changed by user.
- Docker workflow derives GHCR namespace from repository owner automatically.
- Push/CI verification in progress; launcher changes deferred until CI passes.
- GitHub services operational. Current GH_TOKEN rejected by organization policy
  because its lifetime exceeds 366 days; public API reads work unauthenticated.
- Keep historical CI links intact; do not change secrets or token policy.
- Initial SSH inspection automatically added github.com to known_hosts; no
  credentials modified. Subsequent Git commands must use strict host checking.
