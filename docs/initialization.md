# Project initialization

`prime-ralph init` opts one project into Ralph support without launching Prime Agent or starting a workflow.

## Interface

```text
prime-ralph init [--project <path>] [--beads] [--stealth]
```

The current directory is the project unless `--project` selects another existing directory.

## Created structure

Initialization creates only missing entries:

```text
.prime/agent/extensions/prime-ralph -> <installed-package>/src
.ralph/skills/prepare/SKILL.md
.ralph/skills/spec-it-out/SKILL.md
.ralph/skills/plan/SKILL.md
.ralph/skills/execute/SKILL.md
.ralph/skills/blocked/SKILL.md
.ralph/plans/{blocked,future,archive}/
.ralph/logs/
```

The extension uses a directory symlink because Prime Agent `0.9.1` discovers its `index.js` through that directory and resolves the package's relative modules and dependencies from their installed location. A direct file symlink to `src/index.js` does not preserve that resolution behavior and is not used.

Canonical Ralph prompts are internal plugin inputs and are not linked into `.agents/skills/`. This avoids duplicate autocomplete entries and prevents `/skill:<name>` from bypassing the extension's authoritative invocation metadata and preconditions. On repeated initialization, an exact legacy `.agents/skills/<skill>` symlink resolving to `.ralph/skills/<skill>` is removed and reported. Renamed links, dangling links, links to other targets, files, directories, parent directories, and unrelated content are preserved. Parent path symlinks are not followed. Repeating initialization, including with different flags, does not refresh an existing canonical skill.

## Default and Beads modes

Without `--beads`, initialization always uses the default templates. Existing `.beads/` state or an available `bd` executable does not silently change the selected templates.

With `--beads`, initialization uses the Beads-aware template for each missing skill. If `.beads/` is absent, the initializer first requires `bd` and runs `bd init` with `--skip-agents --skip-hooks`. The safe flags keep Beads from competing with prime-ralph for `AGENTS.md` or Git hooks. Normal non-stealth Beads initialization retains Beads' own repository initialization behavior, which can include Git configuration, ignore-file updates, and a Beads commit.

When `--beads` and `--stealth` are combined in a Git worktree, the initializer adds `--setup-exclude` to prevent a premature Beads commit. It snapshots and restores the preexisting `.gitignore`, local exclude file, and repo-local `beads.role` value around `bd init`, then applies only prime-ralph's granular created-path exclusions. This removes Beads' broad recovery/session exclude patterns and restores its local configuration side effect while preserving user content. Existing Beads state is preserved and is not reinitialized.

## Stealth mode

`--stealth` resolves the selected Git worktree's local `info/exclude` file and appends root-anchored patterns only for leaf artifacts created during that invocation. It does not broadly ignore pre-existing `.ralph` or `.prime` trees. If the project is not in a Git worktree, initialization succeeds with a warning and changes no exclude file.

Because stealth tracks only the current invocation, rerunning with `--stealth` after a prior non-stealth initialization does not retroactively exclude existing files.

## Lifecycle boundary

Initialization performs filesystem setup only. It does not import the production extension, launch Prime Agent, call a provider, deliver `prepare`, select a phase, create a goal, or start execution. A later normal Prime Agent session discovers the project-local extension. The production commands are `/reset`, `/spec-it-out`, `/plan`, and `/execute`; execution still begins only after an explicit valid `/execute`.

Package installation and update remain separate operations. Updating the package changes the extension symlink target's implementation and bundled templates for future projects, but it does not rewrite initialized project skills or entrypoints. Run `prime-ralph init` again to apply bounded legacy-link cleanup. End the current Prime Agent session and start or reload a session after updating package source; `/reload` alone is not accepted evidence that previously cached transitive extension modules changed.

## Prompt compatibility

Newly initialized projects receive `spec-it-out` and `plan` skills with `prime-ralph-invocation-version: 1`. These markers are required because both skills consume authoritative state supplied by the plugin. A project initialized by an earlier package retains customized or older files, so the affected command fails safely with an actionable compatibility error until the owner deliberately merges the current canonical invocation contract. Re-running `prime-ralph init` does not overwrite either file.
