/** Enforces the Clean Architecture dependency rule: dependencies point inward only. */
module.exports = {
  forbidden: [
    {
      name: 'domain-is-pure',
      comment: 'domain must not depend on any other layer or on third-party/Node packages',
      severity: 'error',
      from: { path: '^src/domain' },
      to: { pathNot: '^src/domain' },
    },
    {
      name: 'application-depends-only-on-domain',
      severity: 'error',
      from: { path: '^src/application' },
      to: { pathNot: '^src/(domain|application)' },
    },
    {
      name: 'infrastructure-not-on-cli',
      severity: 'error',
      from: { path: '^src/infrastructure' },
      to: { path: '^src/cli' },
    },
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
