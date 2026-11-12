# Release

ONE manual dispatch releases BOTH packages at the same version.

1. Actions tab → **Release** → "Run workflow" → enter a version (e.g. `0.2.0`) and optionally check **beta**.
2. The workflow gates on checks (typecheck/lint/tests/build), then:
   - bumps BOTH `package.json` files (root + `packages/git-colabor`) to the version
   - one release commit, two tags — `v<semver>` (extension) and `cli-v<semver>` (CLI)
   - pushes, packages the `.vsix` + the CLI tarball, creates the GitHub Release
   - publishes to the Visual Studio Marketplace, OpenVSX, and npm (OIDC)

## Required setup (once)

| Item | Where |
| --- | --- |
| `VSCE_PAT` secret | Marketplace token with the "Manage" scope |
| `OVSX_PAT` secret | OpenVSX access token |
| `release` environment | repo → Settings → Environments (npm OIDC binding target) |
| npm trusted publisher | npmjs.com → `git-colabor` → Access: repository `hnrobert/vscode-git-colabor`, workflow `release.yml`, environment `release` |

> The npm package originally published from the standalone `hnrobert/git-colabor`
> repository. After the monorepo merge, its trusted publisher MUST point at
> this repository — publishing fails with an OIDC/origin error otherwise.

## Pre-release mechanics

- Extension: check **beta** → `vsce package --pre-release` + Marketplace/OpenVSX pre-release channel.
- CLI: a semver like `0.2.0-beta.1` (or the **beta** checkbox) publishes under the `beta` dist-tag.
