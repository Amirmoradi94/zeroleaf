# GitHub Release Update Feed

ZeroLeaf release builds check this raw GitHub manifest:

```text
https://raw.githubusercontent.com/Amirmoradi94/zeroleaf/main/docs/updates/zeroleaf-update.json
```

The manifest points at the newest GitHub Release artifact. Keep the JSON small
and public:

```json
{
  "latestVersion": "0.0.0-alpha.3",
  "downloadUrl": "https://github.com/Amirmoradi94/zeroleaf/releases/download/v0.0.0-alpha.3/ZeroLeaf-0.0.0-alpha.3-mac.dmg",
  "releaseNotesUrl": "https://github.com/Amirmoradi94/zeroleaf/releases/tag/v0.0.0-alpha.3",
  "message": "ZeroLeaf 0.0.0-alpha.3 is available."
}
```

## Release Steps

1. Bump the root `package.json` version.
2. Run the release checks:

```bash
npm run typecheck
npm run lint
npm run build
```

3. Package the app with the update feed URL embedded:

```bash
ZEROLEAF_UPDATE_MANIFEST_URL=https://raw.githubusercontent.com/Amirmoradi94/zeroleaf/main/docs/updates/zeroleaf-update.json npm run package:mac:dmg
```

4. Create a GitHub Release tag such as `v0.0.0-alpha.3`.
5. Upload the generated artifact:

```text
release/mac/ZeroLeaf-0.0.0-alpha.3-mac.dmg
```

6. Update `docs/updates/zeroleaf-update.json` so `latestVersion`,
   `downloadUrl`, `releaseNotesUrl`, and `message` point at the new release.
7. Commit and push the manifest update to `main`.
8. Open an older installed build and use `Settings > Updates > Check for
updates`; it should show the new release and open the GitHub download URL.

## Notes

- GitHub raw content can be cached briefly. If a just-pushed manifest does not
  appear immediately, wait a few minutes and check again.
- Users do not need to uninstall old builds. They download the new DMG, quit
  ZeroLeaf, and replace the app in `/Applications`.
- The current implementation downloads manually through the browser. Silent
  in-place updates should wait until release signing and notarization are in
  place.
