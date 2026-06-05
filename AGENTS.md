## Learned User Preferences

- Start with standalone prompt-generated animated videos, not E10 timeline editing, when extending AI Studio with Remotion
- Follow remotion-best-practices strictly for all Remotion composition code: frame-driven motion only; no CSS transitions, CSS animations, or Tailwind animation classes
- Use the superpowers design gate for creative features: explore and clarify scope, write spec, get approval, then write implementation plan before coding
- When asked to ship work, complete remaining items, open a PR, address review comments, fix CI, and merge once checks pass
- Execute approved implementation plans quickly and efficiently once design is signed off

## Learned Workspace Facts

- Spooool is a Cloudflare Workers video platform; GitHub repo is `aloewright/spooool`
- Linear project "Spooool" (team Aloe) tracks roadmap epics E1–E11 with ALO-xxx issue IDs
- Read `.claude/skills/spooool/SKILL.md` for repo conventions before making changes
- AI Studio UI is at `/studio` (`src/frontend/studio/`) with Animated video, Chat, and Image generation sections
- AI animation workflow: prompt → `POST /api/studio/animation` → validated scene schema → `spooool-animation` Remotion composition via render container
- Strand stack utilities require the base `stack` class for flex layout; size classes like `stack-sm` / `stack-xl` only control gap
- Feature specs live in `docs/superpowers/specs/`; executable plans in `docs/superpowers/plans/`
- CI runs `lint:remotion-animation` to block forbidden CSS/Tailwind animation patterns in Remotion code
- `package-lock.json` must be Linux-canonical (CI verifies via `npm install --package-lock-only`); on macOS run `npm run lockfile:linux` after dep changes, never revert vendored `file:*.tgz` deps or move `@rolldown/binding-linux-x64-gnu` out of `optionalDependencies`
