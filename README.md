# DSH external web fetch

Use `web_fetch` with an HTTP method, caller headers, and a serialized body without waiting for upstream PR #2294. The plugin registers `web_search` alongside it.

This repository provides a source checkout installation for a DSH source-tree host. It is not an npm release or a `dsh plugin add` bundle. A registry-only host has not been verified. The copied packages retain their upstream names and stay private.

## Install

Requirements: Node `^22.19.0 || >=24.0.0`, pnpm 11, and an installed DSH source tree with its dependencies. On the author's macOS machine, prepend `/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin` to `PATH`.

```sh
git clone https://github.com/Chinesezjc/dsh-web-fetch.git
cd dsh-web-fetch
pnpm install --frozen-lockfile
pnpm run verify
node profile/install-headless.mjs --dry-run
node profile/install-headless.mjs --profile external-web-fetch
```

The installer creates `$DSH_HOME/profiles/external-web-fetch`, or `~/.dsh/profiles/external-web-fetch` when `DSH_HOME` is unset. It derives absolute plugin paths from this checkout. Keep the checkout and its built `lib/` files in place.

The profile uses the host's base and headless bundles. It disables the release `web`, `web-fetch-http`, and `tool-web` rows and inserts this repository's built plugins. It leaves the search provider enabled.

The installer rejects `web`, `headless`, invalid names, and every existing destination profile, including a symlink. It does not copy credentials, modify global settings, or overwrite an earlier installation. Use `--home /path/to/scratch-home` to install in a scratch home. Choose a new profile name when testing a different checkout.

## Verify the installed profile

`pnpm run verify` builds the packages, runs a loopback HTTP smoke through the tool registry, and tests the installer. The smoke replaces address resolution only inside its process because production fetches reject non-public destinations. It checks method, headers, body, schema, and argument rejection; it is not a real-model round.

To verify the generated profile using the installed host's own parser and Cordis modules, set these paths for your machine:

```sh
export DSH_HOST_TREE="$HOME/.dsh/source/current"
export DSH_SELFUSE_PATCH="$HOME/.dsh/profiles/external-web-fetch/cordis.patch.yml"
TSX_TSCONFIG_PATH="$DSH_HOST_TREE/tsconfig.json" \
  node --import "$DSH_HOST_TREE/node_modules/tsx/dist/esm/index.mjs" \
  profile/verify-profile-schema.mjs
```

Expected output includes `web_fetch parameters: url, method, headers, body` and `registered web tools: web_search, web_fetch`. The probe fails if release rows remain enabled, paths point outside this checkout, or the tool schema differs.

The profile launches through `dsh --profile external-web-fetch`. Model access still requires your existing DSH provider configuration and credentials; this repository supplies neither. Do not put credentials in a Git commit.

## Web profile preflight

`profile/prepare-web-profile.mjs` prepares backups and four ordered candidate patches for an existing Web profile. It does not apply them, reload the instance, or change presets, dependencies, or bundles. The candidates keep the host web service and replace only its global tool and HTTP provider. Both registries reject duplicate registrations: an operator must verify each old registration has finished unloading before enabling its replacement. Applying the final candidate directly through concurrent HMR is not verified safe.

```sh
node profile/prepare-web-profile.mjs \
  --profile-dir "$HOME/.dsh/profiles/web" \
  --output /tmp/external-web-fetch-plan
TSX_TSCONFIG_PATH="$DSH_HOST_TREE/tsconfig.json" \
  node --import "$DSH_HOST_TREE/node_modules/tsx/dist/esm/index.mjs" \
  profile/verify-web-integration.mjs
```

The output directory must not exist. The probe checks ordered replacement against the installed host's service and tool registry, executes a scoped POST with a header and body against loopback, and verifies the four-field schema. It also verifies a limitation: a preset-local release `web_fetch` shadows the global replacement. Presets configured with `fetch: false` can inherit it; presets configured with `fetch: true` retain their own tool. This is isolated integration evidence, not a claim that a running Web instance has been modified.

For a session using the shipped `standard` preset, `node profile/generate-web-preset.mjs --output /tmp/external-web-fetch-presets/external-web-fetch-standard` generates a separate opt-in copy with the external tool module. It preserves the shipped preset and rejects missing or duplicate tool rows and existing output directories. Generate the copy under an already scanned user preset root, or register its parent as an additional preset root in the Web profile. Select `external-web-fetch-standard` in a new blank session through the normal preset control. A session that has already started keeps its original preset and cannot switch. Generating files alone neither registers an additional root nor selects the preset. Keep the external HTTP provider enabled in the host profile. Run `profile/verify-web-preset.mjs --root /tmp/external-web-fetch-presets` through the same host tsx command shown above to check package presence against the profile's actual resolution table. This check is not a full agent startup or a live session selection.

Before applying a candidate, compare the live patch and manifest against the backup hashes in `plan.json`, inspect the final configuration after all overlays, and establish an authenticated way to read live plugin and session-tool status. Do not bypass authentication or assume that a successful file write proves HMR succeeded. A service restart requires operator approval.

## Tool arguments

| Field | Meaning |
| --- | --- |
| `url` | Required public HTTP(S) URL. |
| `method` | GET (default), POST, PUT, PATCH, DELETE, or HEAD. |
| `headers` | Header name/value strings; transport-managed header names are rejected. |
| `body` | Serialized text; rejected with GET and HEAD. Set a matching Content-Type header. |

Use a non-secret test header when checking an echo endpoint. The provider refuses credential-bearing redirects. See the implementation in `packages/web-fetch-http/src/policy.ts` and `provider.ts` for request policy.

## Scope and compatibility

- Verified integration target: source-tree host commit `6c59d4da55067a698e6ddda8376a9eb649ee9e43`. The host must supply the same Cordis and DSH service instances used by the loaded plugins. Module resolution under an unrelated npm-only host is not established.
- The automatic installer is headless-only. Web preflight can generate a separate opt-in preset but does not install or select it in a running session. Browser tool cards are unchanged. Regenerate the opt-in preset after host updates; the author's older GUI self-use profile is separate from this installation.
- The source uses pinned DSH `0.1.5-rc.2` dependencies. Rerun verification after updating the host; passing on one host version is not a compatibility promise for every later version.
- This repository contains no credentials, copied user settings, raw model transcripts, or GUI captures from the self-use repository. Historical evidence remains local. See [PROVENANCE.md](PROVENANCE.md).

## Development

The three workspaces are the `ctx.web` service (`packages/web`), HTTP provider (`packages/web-fetch-http`), and model-facing tool (`packages/tool-web`). `profile/install-headless.test.mjs` checks installation, protected paths, overwrite refusal, symlink refusal, and dry-run. The schema probe uses the actual generated patch rather than a second fixture.
