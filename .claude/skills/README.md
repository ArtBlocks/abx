# Skills in this repository

ABX keeps two agent skills in source control:

| Skill | Audience | Published |
| --- | --- | --- |
| `abx/` | People using ABX | Bundled with `@artblocks/abx-cli` and the Claude plugin in Anthropic's directory |
| `dev-loop-test/` | Contributors testing the CLI and end-user skill | No |

The `abx` skill's canonical files live in `plugin/skills/abx/`; `.claude/skills/abx` is a symlink to
them. Contributor skills live under `.claude/skills/`. Matching symlinks under `.agents/skills/`
make contributor skills discoverable by agents that use the vendor-neutral directory.

The `abx` skill is a published artifact. Its frontmatter version is stamped from the CLI package
during release, and prepack checks that the bundled copy is current. Test installation inside a
clean-room sandbox; do not install over the canonical source directory.

Contributor skills must describe reproducible repository workflows. Do not add skills that depend on
private queues, internal organizational ownership, non-public strategy, or credentials unavailable to
outside contributors.
