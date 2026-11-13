# Release

ONE manual dispatch releases BOTH packages at the same version.

1. Actions tab → **Release** → "Run workflow" → enter a version (e.g. `0.2.0`) and optionally check **beta**.
2. The workflow gates on checks (typecheck/lint/tests/build), then:
   - bumps BOTH `package.json` files (root + `packages/git-colabor`) to the version
   - one release commit + ONE tag `v<semver>` covering both packages
   - pushes, packages the `.vsix` + the CLI tarball, creates the GitHub Release
   - publishes to the Visual Studio Marketplace, OpenVSX, and npm (OIDC)

## Required setup (once)

| Item | Where |
| --- | --- |
| `VSCE_PAT` secret | Marketplace token with the "Manage" scope |
| `OVSX_PAT` secret | OpenVSX access token |
| npm trusted publisher | npmjs.com → `git-colabor` → Access: repository `hnrobert/vscode-git-colabor`, workflow `release.yml`, environment **empty** |

> The npm package originally published from the standalone `hnrobert/git-colabor`
> repository. After the monorepo merge, its trusted publisher MUST point at
> this repository — publishing fails with an OIDC/origin error otherwise.

## Preview releases (develop → auto beta)

`release-preview.yml` fires on every REAL push to `develop` (path-filtered;
release-sync commits are skipped). One run = gate on checks → compute the
next `X.Y.(Z+1)-beta.N` no tag claims → bump BOTH packages into a
branchless commit (only the tag is pushed, develop never moves) → GitHub
prerelease with the vsix + CLI tarball → Marketplace **pre-release** +
npm **`beta` dist-tag**. OpenVSX is skipped (no pre-release concept there);
stable releases publish to it as usual.

`sync-develop.yml` fast-forwards develop from main on every push to main —
stable-release commits flow into develop automatically without triggering a
preview (message-prefix guard).

> npm OIDC: trusted publisher bindings are PER WORKFLOW FILE — add a second
> binding for `release-preview.yml` (same repository, environment empty),
> in addition to the `release.yml` one.

## Pre-release mechanics

- Extension: **beta** → `vsce package --pre-release` + Marketplace pre-release channel. OpenVSX has no pre-release concept — the same vsix is published there as a regular version.
- CLI (npm): **beta** → published under the `beta` dist-tag.
