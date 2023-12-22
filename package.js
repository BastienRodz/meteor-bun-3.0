/* eslint-env meteor */

Package.describe({
  summary: 'Authorization package for Meteor',
  version: '4.0.0-alpha.1',
  git: 'https://github.com/Meteor-Community-Packages/meteor-roles.git',
  name: 'alanning:roles'
})

Package.onUse(function (api) {
  api.versionsFrom(['2.8.1', '3.0-alpha.11'])

  const both = ['client', 'server']

  api.use([
    'ecmascript',
    'accounts-base',
    'tracker',
    'mongo',
    'check'
  ], both)

  api.use('zodern:types@1.0.10')

  api.use(['blaze@2.7.1'], 'client', { weak: true })

  api.export('Roles')

  api.addFiles('roles/roles_common.js', both)
  api.addFiles('roles/roles_common_async.js', both)
  api.addFiles('roles/roles_server.js', 'server')
  api.addFiles([
    'roles/client/debug.js',
    'roles/client/uiHelpers.js',
    'roles/client/subscriptions.js'
  ], 'client')
})

Package.onTest(function (api) {
  // Add code coverage
  api.use([
    'lmieulet:meteor-legacy-coverage',
    'lmieulet:meteor-coverage@4.1.0',
    'meteortesting:mocha@2.1.0'
  ])

  api.versionsFrom('2.8.1')

  const both = ['client', 'server']

  // `accounts-password` is included so `Meteor.users` exists

  api.use([
    'ecmascript',
    'alanning:roles',
    'mongo'
  ], both)

  api.addFiles('roles/tests/server.js', 'server')
  api.addFiles('roles/tests/serverAsync.js', 'server')
  api.addFiles('roles/tests/client.js', 'client')
  api.addFiles('roles/tests/clientAsync.js', 'client')
})
