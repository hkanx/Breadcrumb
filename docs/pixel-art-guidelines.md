# Pixel Art Guidelines (Vault-Only Cozy Theme)

## Scope
- Decorative pixel art is applied to the Vault sidebar only.
- No changes to capture, storage, or data schema.

## Palette
- Butter yellow: `#F6D27A`
- Toast brown: `#C68B59`
- Latte cream: `#F3E5D0`
- Warm beige: `#D8B89C`
- Soft cat pink: `#F4C7C3`

## Sprite Set
Location: `assets/pixel/`

- `cat-32.png`, `cat-24.png`
- `toast-32.png`, `toast-24.png`
- `latte-32.png`, `latte-24.png`
- `crumb-10.png`, `star-10.png`, `heart-10.png`

## Export Rules
- PNG-8 palette-reduced.
- Keep transparent backgrounds.
- Keep dimensions small:
  - mascot sprites: 24x24 or 32x32
  - decor sprites: 8x8 to 12x12
- Use nearest-neighbor scaling only; no interpolation.

## Size Budget
- Decorative assets budget (this feature): **<= 120 KB total** in `assets/pixel/`.

### Manual check
```bash
find assets/pixel -type f -name '*.png' -print0 | xargs -0 stat -f '%z %N'
find assets/pixel -type f -name '*.png' -print0 | xargs -0 stat -f '%z' | awk '{sum += $1} END {printf "Total bytes: %d\n", sum}'
```

## Motion and Accessibility
- Animation is CSS-only (no JS loop).
- Motion is subtle and low-frequency.
- Must respect `prefers-reduced-motion: reduce`.
