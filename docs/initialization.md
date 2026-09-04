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
.agents/skills/<skill> -> ../../.ralph/skills/<skill>
```

The extension uses a directory symlink because Prime Agent `0.9.1` discovers its `index.js` through that directory and resolves the package's relative modules and dependencies from their installed location. A direct file symlink to `src/index.js` does not preserve that resolution behavior and is not used.

Existing regular files, directories, customized skills, and correct links are preserved. Conflicting entries are also preserved and reported as warnings. Parent path symlinks are not followed, which prevents initialization from writing outside the selected project. Repeating initialization, including with different flags, does not refresh an existing canonical skill.

## Default and Beads modes

Without `--beads`, initialization always uses the default templates. Existing `.beads/` state or an available `bd` executable does not silently change the selected templates.

With `--beads`, initialization uses the Beads-aware template for each missing skill. If `.beads/` is absent, the initializer first requires `bd` and runs `bd init` with `--skip-agents --skip-hooks`. The safe flags keep Beads from competing with prime-ralph for `AGENTS.md` or Git hooks. Normal non-stealth Beads initialization retains Beads' own repository initialization behavior, which can include Git configuration, ignore-file updates, and a Beads commit.

When `--beads` and `--stealth` are combined in a Git worktree, the initializer adds `--setup-exclude` to prevent a premature Beads commit. It snapshots and restores the preexisting `.gitignore`, local exclude file, and repo-local `beads.role` value around `bd init`, then applies only prime-ralph's granular created-path exclusions. This removes Beads' broad recovery/session exclude patterns and restores its local configuration side effect while preserving user content. Existing Beads state is preserved and is not reinitialized.

## Stealth mode

`--stealth` resolves the selected Git worktree's local `info/exclude` file and appends root-anchored patterns only for leaf artifacts created during that invocation. It does not broadly ignore pre-existing `.ralph`, `.prime`, or `.agents` trees. If the project is not in a Git worktree, initialization succeeds with a warning and changes no exclude file.

Because stealth tracks only the current invocation, rerunning with `--stealth` after a prior non-stealth initialization does not retroactively exclude existing files.

## Lifecycle boundary

Initialization performs filesystem setup only. It does not import the production extension, launch Prime Agent, call a provider, deliver `prepare`, select a phase, create a goal, or start execution. A later normal Prime Agent session discovers the project-local extension. At the current Slice 2 boundary, `/reset` is the only production Ralph command implemented.

Package installation and update remain separate operations. Updating the package changes the symlink target's implementation and bundled templates for future projects, but it does not rewrite initialized project skills or entrypoints.
