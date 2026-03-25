# Kimaki Project Memory

## When to Reinstall

**Always rebuild and verify after:**
1. Completing a new feature
2. Merging upstream changes
3. Modifying TypeScript source files in `discord/src/`
4. Updating dependencies (`pnpm install`)

## Reinstalling Kimaki from Local Source

After making changes to the kimaki source code and needing to test them with the global `kimaki` command, follow these steps:

### Step 1: Remove global kimaki installations

```bash
# Remove npm global kimaki (if installed via npm)
npm uninstall -g kimaki

# Remove homebrew kimaki symlink (if installed via homebrew)
rm -f /opt/homebrew/lib/node_modules/kimaki
rm -f /opt/homebrew/bin/kimaki
```

### Step 2: Rebuild the TypeScript dist files

```bash
cd discord
npx tsc
```

### Step 3: Link the local package globally

```bash
pnpm link --global
```

This creates a symlink from `~/.local/share/pnpm/global` to your local `discord/` directory, and adds the `kimaki` binary to `~/.local/share/pnpm/bin` (or similar path depending on your pnpm config).

### Step 4: Verify the installation

```bash
# Check which kimaki is being used
which kimaki

# Should show something like:
# /Users/caffae/Library/pnpm/kimaki

# Or on Linux:
# ~/.local/share/pnpm/kimaki

# Run kimaki to verify the banner shows your changes
kimaki
```

### Notes

- The global `kimaki` command runs `bin.js` which imports `dist/cli.js`, NOT `src/cli.ts`
- You must rebuild with `npx tsc` after TypeScript changes
- For quick development iteration, use `pnpm dev` which runs `tsx src/cli.ts` directly (no build needed)
- If you see `/opt/homebrew/bin/kimaki`, you still have a homebrew installation overriding your local link

## Quick Rebuild Command

Run this after completing features or merging upstream:

```bash
# One-liner to rebuild and verify
npm uninstall -g kimaki 2>/dev/null; pnpm install && cd discord && npx tsc && cd .. && which kimaki && echo "✅ Rebuild complete - test with: kimaki"
```

## Common Issues

### "I don't see my changes when running kimaki"

This means you're running an old compiled version. Run the quick rebuild command above.

### "Module not found errors after merge"

Upstream may have added new dependencies. Fix with:
```bash
pnpm install
cd discord && npx tsc
```

### "npm global kimaki keeps overriding my dev version"

npm's `/opt/homebrew/bin` comes before pnpm's `~/Library/pnpm` in PATH. Uninstall the npm version:
```bash
npm uninstall -g kimaki
```