# Repository and image location

The current repository is [vibe-wallets/solana-wallet-cli](https://github.com/vibe-wallets/solana-wallet-cli).
Development continues on `master`. The launcher now defaults to
`ghcr.io/vibe-wallets/sol-wallet:master`; `SOL_WALLET_IMAGE` still overrides it.
Changing the image location does not change the mounted wallet directory or
keystore format. Existing wallets require no migration.

Docker CI derives its image owner from `github.repository_owner`, so moving to
the organization does not require a hardcoded workflow change. Successful pushes
publish the exact E2E-tested image with branch, short commit, and `latest` tags.
Historical validation links in older documentation deliberately retain their
original repository location.

## Verification on October 6, 2026

- SSH push to the new origin succeeded and established `origin/master` tracking.
- [Initial Docker workflow](https://github.com/vibe-wallets/solana-wallet-cli/actions/runs/37501865520)
  passed formatting, unit tests, build, Docker E2E, and image publication.
- The `master` image pulled successfully using this host's existing Docker
  credentials. Anonymous GHCR token access returned HTTP 401: users without
  package access cannot pull it yet. An organization/package administrator must
  make the package public if anonymous installation is desired; visibility was
  not changed automatically.
- All three launcher unit tests, TypeScript lint, Bash syntax, and changed-file
  formatting checks passed locally. Follow-up CI validates the migrated default.
- The current host's `GH_TOKEN` is rejected by the organization's token policy:
  its lifetime exceeds 366 days. Public CI can be inspected unauthenticated;
  authenticated GitHub CLI operations need a policy-compliant token. No token,
  organization policy, or Docker credentials were changed.
- An initial SSH inspection automatically added GitHub's host key to
  `known_hosts`; subsequent Git commands use strict host checking. No system
  packages were installed.

This verifies the Docker workflow, not live Devnet tests or the credentials and
state required by the separate scheduled Devnet workflow. Never copy private
wallet material into repository files when configuring that workflow.
