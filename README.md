# prime-ralph

A standalone Prime Agent plugin implementing best-practice Ralph loop design in Prime Agent.

## Current status

This repository is at the compatibility baseline slice. The extension entry point is intentionally behavior-neutral while lifecycle research and proof-of-concept work validate Prime Agent event ordering, goal continuation, compaction, and context boundaries.

## Development

```sh
npm test
npm run compat
```

The production workflow, configurable repository skill files, plugin-native phase selection, and Ralph-style compaction boundary are specified in the parent control repository until this standalone project carries its own specification.
