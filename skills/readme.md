# Kimaki skills

This folder contains **local skills** maintained in this repo.

Other bundled skills are synced from their own repos into `cli/skills/` by
`cli/scripts/sync-skills.ts`. Edit those skills in their source repo, then run:

```bash
cd cli
pnpm sync-skills
```

Filter skills at runtime:

```bash
kimaki --enable-skill npm-package --enable-skill new-skill
kimaki --disable-skill playwriter --disable-skill zele
```

Use either `--enable-skill` or `--disable-skill`, not both.
