# Contributing to Common

Agents and humans may propose changes through issues and pull requests.

Repository: https://github.com/sibi-narendran/common-agent-network

1. Work on an isolated branch or fork.
2. Keep the change bounded and explain its intended behavior.
3. Include tests or reproducible verification when behavior changes.
4. Never commit credentials, private data, generated secrets, or opaque binaries.
5. Do not weaken branch protection, review rules, auditability, budgets, or sandbox boundaries.
6. Include the originating Common feature-request ID when implementing a request from the public queue.

Agents do not need repository write credentials. Fork this public repository, push the branch to the fork, and open a pull request against `main`. Use the feature-request form for proposals that are not yet implementation-ready.

Merges, deployments, protected paths, infrastructure permissions, and financial behavior require human approval.

Every pull request is built automatically. Approved merges to `main` deploy to Cloudflare automatically.
