# Release checklist

## Automated gates

Run `npm ci`, `npm test`, `npm run build`, and `npm run check-release`.
The release workflow repeats these checks before creating a draft GitHub
release with `main.js`, `manifest.json`, and `styles.css`.

Use exact `x.y.z` tags without a `v` prefix, matching the manifest version.
Update `package.json`, `package-lock.json`, `manifest.json`, and `versions.json`
together. Historical compatibility entries remain in `versions.json`.

## Manual launch gates

- [x] Validate desktop Live Preview, Reading View, and Source-mode navigation.
- [x] Validate actual iOS and Android devices: add/edit/complete/delete, menus,
  native date picking, source-note selection, keyboard submission/cancel,
  narrow panes, and touch targets.
- [x] Check light and dark themes, keyboard focus, and reduced-motion behavior.
- [x] Check startup, disable/re-enable, rename, and multiple panes without draft loss.
- [x] Review screenshot/demo assets to ensure they contain only sample data.
- [x] Confirm the minimum supported Obsidian version on a compatible installation.
- [x] Review the current developer policies and submission requirements.

Desktop testing and narrow-pane checks do not establish mobile compatibility.
Do not publish until device validation is complete.

### Local validation record

On 25 October 2026, the standalone build passed its automated suite, production
build, release checks, and clean offline installation from the npm cache using
public-registry lockfile URLs.

Live smoke checks in Obsidian 1.12.7 on macOS covered initial read-without-write,
adding with priority/due date, status/priority changes, inline editing via Save,
completion/reopening, collapse, deletion, rollover/source-note navigation,
note rename, disable/re-enable, and Live Preview/Reading View remounts.
The actions menu was measured opening leftward beneath its trigger.
Screenshot and demo assets contain only dedicated sample-note data.
Additional checks covered named empty-list initialization, exact Source-mode
cursor positioning, and a 320px-wide list/menu without horizontal overflow.

Real-keyboard dispatch, actual iOS/Android devices, the minimum Obsidian version,
and the remaining launch gates above are not established by this record.

### Maintainer release sign-off

On 25 October 2026, the maintainer confirmed the remaining manual launch gates
and authorized publication of version 1.0.0. This is maintainer-reported sign-off;
individual device models, operating-system versions, and compatibility-test
results were not recorded in the independent desktop validation above.

The current [developer policies](https://docs.obsidian.md/community-directory/developer-policies)
and [submission requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)
were reviewed before tagging. The plugin uses no networking, telemetry,
Node.js/Electron runtime APIs, external-vault file access, or account/payment
requirements. It includes its MIT license and the bundled YAML license notice.

## First publication

1. Create the public `shettypuneeth/kanso-todos-obsidian` repository and push the
   source to its default `main` branch.
2. Complete all launch gates, create the `1.0.0` tag, and push it.
3. Review and publish the generated draft release.
4. Sign in to the [Obsidian Community directory](https://community.obsidian.md),
   link the owning GitHub account, and submit the plugin using the
   [current submission instructions](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin).
5. Resolve automated review feedback and publish a new version if required.

The manifest at the default-branch HEAD must match the intended release.
Repository name and plugin ID are distinct: the repository ends in `-obsidian`,
but the plugin ID is `kanso-todos`.

The README describes the intended Community Plugins installation flow; it does
not establish listing status. Never claim a community listing or mobile test
result before it exists.
