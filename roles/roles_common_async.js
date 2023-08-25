/* global Roles */
import { Meteor } from 'meteor/meteor'
import { Mongo } from 'meteor/mongo'

/**
 * Provides functions related to user authorization. Compatible with built-in Meteor accounts packages.
 *
 * Roles are accessible throgh `Meteor.roles` collection and documents consist of:
 *  - `_id`: role name
 *  - `children`: list of subdocuments:
 *    - `_id`
 *
 * Children list elements are subdocuments so that they can be easier extended in the future or by plugins.
 *
 * Roles can have multiple parents and can be children (subroles) of multiple roles.
 *
 * Example: `{_id: 'admin', children: [{_id: 'editor'}]}`
 *
 * The assignment of a role to a user is stored in a collection, accessible through `Meteor.roleAssignment`.
 * It's documents consist of
 *  - `_id`: Internal MongoDB id
 *  - `role`: A role object which got assigned. Usually only contains the `_id` property
 *  - `user`: A user object, usually only contains the `_id` property
 *  - `scope`: scope name
 *  - `inheritedRoles`: A list of all the roles objects inherited by the assigned role.
 *
 * @module Roles
 */
if (!Meteor.roles) {
  Meteor.roles = new Mongo.Collection('roles')
}

if (!Meteor.roleAssignment) {
  Meteor.roleAssignment = new Mongo.Collection('role-assignment')
}

/**
 * @class Roles
 */
if (typeof Roles === 'undefined') {
  Roles = {} // eslint-disable-line no-global-assign
}

let getGroupsForUserDeprecationWarning = false

/**
 * Helper, resolves async some
 * @param {*} arr
 * @param {*} predicate
 * @returns {Promise<Boolean>}
 */
const asyncSome = async (arr, predicate) => {
  for (const e of arr) {
    if (await predicate(e)) return true
  }
  return false
}

Object.assign(Roles, {
  /**
   * Used as a global group (now scope) name. Not used anymore.
   *
   * @property GLOBAL_GROUP
   * @static
   * @deprecated
   */
  GLOBAL_GROUP: null,

  /**
   * Create a new role.
   *
   * @method createRole
   * @param {String} roleName Name of role.
   * @param {Object} [options] Options:
   *   - `unlessExists`: if `true`, exception will not be thrown in the role already exists
   * @return {Promise<String>} ID of the new role or null.
   * @static
   */
  createRoleAsync: async function (roleName, options) {
    Roles._checkRoleName(roleName)

    options = Object.assign(
      {
        unlessExists: false
      },
      options
    )

    let insertedId = null

    const existingRole = await Meteor.roles.findOneAsync({ _id: roleName })

    if (existingRole) {
      await Meteor.roles.updateAsync(
        { _id: roleName },
        { $setOnInsert: { children: [] } }
      )
      return null
    } else {
      insertedId = await Meteor.roles.insertAsync({
        _id: roleName,
        children: []
      })
    }

    if (!insertedId) {
      if (options.unlessExists) return null
      throw new Error("Role '" + roleName + "' already exists.")
    }

    return insertedId
  },

  /**
   * Delete an existing role.
   *
   * If the role is set for any user, it is automatically unset.
   *
   * @method deleteRole
   * @param {String} roleName Name of role.
   * @returns {Promise}
   * @static
   */
  deleteRoleAsync: async function (roleName) {
    let roles
    let inheritedRoles

    Roles._checkRoleName(roleName)

    // Remove all assignments
    await Meteor.roleAssignment.removeAsync({
      'role._id': roleName
    })

    do {
      // For all roles who have it as a dependency ...
      roles = Roles._getParentRoleNames(
        await Meteor.roles.findOneAsync({ _id: roleName })
      )

      for (const r of await Meteor.roles
        .find({ _id: { $in: roles } })
        .fetchAsync()) {
        await Meteor.roles.updateAsync(
          {
            _id: r._id
          },
          {
            $pull: {
              children: {
                _id: roleName
              }
            }
          }
        )

        inheritedRoles = await Roles._getInheritedRoleNamesAsync(
          await Meteor.roles.findOneAsync({ _id: r._id })
        )
        await Meteor.roleAssignment.updateAsync(
          {
            'role._id': r._id
          },
          {
            $set: {
              inheritedRoles: [r._id, ...inheritedRoles].map((r2) => ({
                _id: r2
              }))
            }
          },
          { multi: true }
        )
      }
    } while (roles.length > 0)

    // And finally remove the role itself
    await Meteor.roles.removeAsync({ _id: roleName })
  },

  /**
   * Rename an existing role.
   *
   * @method renameRole
   * @param {String} oldName Old name of a role.
   * @param {String} newName New name of a role.
   * @returns {Promise}
   * @static
   */
  renameRoleAsync: async function (oldName, newName) {
    let count

    Roles._checkRoleName(oldName)
    Roles._checkRoleName(newName)

    if (oldName === newName) return

    const role = await Meteor.roles.findOneAsync({ _id: oldName })

    if (!role) {
      throw new Error("Role '" + oldName + "' does not exist.")
    }

    role._id = newName

    await Meteor.roles.insertAsync(role)

    do {
      count = await Meteor.roleAssignment.updateAsync(
        {
          'role._id': oldName
        },
        {
          $set: {
            'role._id': newName
          }
        },
        { multi: true }
      )
    } while (count > 0)

    do {
      count = await Meteor.roleAssignment.updateAsync(
        {
          'inheritedRoles._id': oldName
        },
        {
          $set: {
            'inheritedRoles.$._id': newName
          }
        },
        { multi: true }
      )
    } while (count > 0)

    do {
      count = await Meteor.roles.updateAsync(
        {
          'children._id': oldName
        },
        {
          $set: {
            'children.$._id': newName
          }
        },
        { multi: true }
      )
    } while (count > 0)

    await Meteor.roles.removeAsync({ _id: oldName })
  },

  /**
   * Add role parent to roles.
   *
   * Previous parents are kept (role can have multiple parents). For users which have the
   * parent role set, new subroles are added automatically.
   *
   * @method addRolesToParent
   * @param {Array|String} rolesNames Name(s) of role(s).
   * @param {String} parentName Name of parent role.
   * @returns {Promise}
   * @static
   */
  addRolesToParentAsync: async function (rolesNames, parentName) {
    // ensure arrays
    if (!Array.isArray(rolesNames)) rolesNames = [rolesNames]

    for (const roleName of rolesNames) {
      await Roles._addRoleToParentAsync(roleName, parentName)
    }
  },

  /**
   * @method _addRoleToParent
   * @param {String} roleName Name of role.
   * @param {String} parentName Name of parent role.
   * @returns {Promise}
   * @private
   * @static
   */
  _addRoleToParentAsync: async function (roleName, parentName) {
    Roles._checkRoleName(roleName)
    Roles._checkRoleName(parentName)

    // query to get role's children
    const role = await Meteor.roles.findOneAsync({ _id: roleName })

    if (!role) {
      throw new Error("Role '" + roleName + "' does not exist.")
    }

    // detect cycles
    if ((await Roles._getInheritedRoleNamesAsync(role)).includes(parentName)) {
      throw new Error(
        "Roles '" + roleName + "' and '" + parentName + "' would form a cycle."
      )
    }

    const count = await Meteor.roles.updateAsync(
      {
        _id: parentName,
        'children._id': {
          $ne: role._id
        }
      },
      {
        $push: {
          children: {
            _id: role._id
          }
        }
      }
    )

    // if there was no change, parent role might not exist, or role is
    // already a subrole; in any case we do not have anything more to do
    if (!count) return

    await Meteor.roleAssignment.updateAsync(
      {
        'inheritedRoles._id': parentName
      },
      {
        $push: {
          inheritedRoles: {
            $each: [
              role._id,
              ...(await Roles._getInheritedRoleNamesAsync(role))
            ].map((r) => ({ _id: r }))
          }
        }
      },
      { multi: true }
    )
  },

  /**
   * Remove role parent from roles.
   *
   * Other parents are kept (role can have multiple parents). For users which have the
   * parent role set, removed subrole is removed automatically.
   *
   * @method removeRolesFromParent
   * @param {Array|String} rolesNames Name(s) of role(s).
   * @param {String} parentName Name of parent role.
   * @returns {Promise}
   * @static
   */
  removeRolesFromParentAsync: async function (rolesNames, parentName) {
    // ensure arrays
    if (!Array.isArray(rolesNames)) rolesNames = [rolesNames]

    for (const roleName of rolesNames) {
      await Roles._removeRoleFromParentAsync(roleName, parentName)
    }
  },

  /**
   * @method _removeRoleFromParent
   * @param {String} roleName Name of role.
   * @param {String} parentName Name of parent role.
   * @returns {Promise}
   * @private
   * @static
   */
  _removeRoleFromParentAsync: async function (roleName, parentName) {
    Roles._checkRoleName(roleName)
    Roles._checkRoleName(parentName)

    // check for role existence
    // this would not really be needed, but we are trying to match addRolesToParent
    const role = await Meteor.roles.findOneAsync(
      { _id: roleName },
      { fields: { _id: 1 } }
    )

    if (!role) {
      throw new Error("Role '" + roleName + "' does not exist.")
    }

    const count = await Meteor.roles.updateAsync(
      {
        _id: parentName
      },
      {
        $pull: {
          children: {
            _id: role._id
          }
        }
      }
    )

    // if there was no change, parent role might not exist, or role was
    // already not a subrole; in any case we do not have anything more to do
    if (!count) return

    // For all roles who have had it as a dependency ...
    const roles = [
      ...(await Roles._getParentRoleNamesAsync(
        await Meteor.roles.findOneAsync({ _id: parentName })
      )),
      parentName
    ]

    for (const r of await Meteor.roles
      .find({ _id: { $in: roles } })
      .fetchAsync()) {
      const inheritedRoles = await Roles._getInheritedRoleNamesAsync(
        await Meteor.roles.findOneAsync({ _id: r._id })
      )
      await Meteor.roleAssignment.updateAsync(
        {
          'role._id': r._id,
          'inheritedRoles._id': role._id
        },
        {
          $set: {
            inheritedRoles: [r._id, ...inheritedRoles].map((r2) => ({
              _id: r2
            }))
          }
        },
        { multi: true }
      )
    }
  },

  /**
   * Add users to roles.
   *
   * Adds roles to existing roles for each user.
   *
   * @example
   *     Roles.addUsersToRoles(userId, 'admin')
   *     Roles.addUsersToRoles(userId, ['view-secrets'], 'example.com')
   *     Roles.addUsersToRoles([user1, user2], ['user','editor'])
   *     Roles.addUsersToRoles([user1, user2], ['glorious-admin', 'perform-action'], 'example.org')
   *
   * @method addUsersToRoles
   * @param {Array|String} users User ID(s) or object(s) with an `_id` field.
   * @param {Array|String} roles Name(s) of roles to add users to. Roles have to exist.
   * @param {Object|String} [options] Options:
   *   - `scope`: name of the scope, or `null` for the global role
   *   - `ifExists`: if `true`, do not throw an exception if the role does not exist
   * @returns {Promise}
   *
   * Alternatively, it can be a scope name string.
   * @static
   */
  addUsersToRolesAsync: async function (users, roles, options) {
    let id

    if (!users) throw new Error("Missing 'users' param.")
    if (!roles) throw new Error("Missing 'roles' param.")

    options = Roles._normalizeOptions(options)

    // ensure arrays
    if (!Array.isArray(users)) users = [users]
    if (!Array.isArray(roles)) roles = [roles]

    Roles._checkScopeName(options.scope)

    options = Object.assign(
      {
        ifExists: false
      },
      options
    )

    for (const user of users) {
      if (typeof user === 'object') {
        id = user._id
      } else {
        id = user
      }

      for (const role of roles) {
        await Roles._addUserToRoleAsync(id, role, options)
      }
    }
  },

  /**
   * Set users' roles.
   *
   * Replaces all existing roles with a new set of roles.
   *
   * @example
   *     Roles.setUserRoles(userId, 'admin')
   *     Roles.setUserRoles(userId, ['view-secrets'], 'example.com')
   *     Roles.setUserRoles([user1, user2], ['user','editor'])
   *     Roles.setUserRoles([user1, user2], ['glorious-admin', 'perform-action'], 'example.org')
   *
   * @method setUserRoles
   * @param {Array|String} users User ID(s) or object(s) with an `_id` field.
   * @param {Array|String} roles Name(s) of roles to add users to. Roles have to exist.
   * @param {Object|String} [options] Options:
   *   - `scope`: name of the scope, or `null` for the global role
   *   - `anyScope`: if `true`, remove all roles the user has, of any scope, if `false`, only the one in the same scope
   *   - `ifExists`: if `true`, do not throw an exception if the role does not exist
   * @returns {Promise}
   *
   * Alternatively, it can be a scope name string.
   * @static
   */
  setUserRolesAsync: async function (users, roles, options) {
    let id

    if (!users) throw new Error("Missing 'users' param.")
    if (!roles) throw new Error("Missing 'roles' param.")

    options = Roles._normalizeOptions(options)

    // ensure arrays
    if (!Array.isArray(users)) users = [users]
    if (!Array.isArray(roles)) roles = [roles]

    Roles._checkScopeName(options.scope)

    options = Object.assign(
      {
        ifExists: false,
        anyScope: false
      },
      options
    )

    for (const user of users) {
      if (typeof user === 'object') {
        id = user._id
      } else {
        id = user
      }
      // we first clear all roles for the user
      const selector = { 'user._id': id }
      if (!options.anyScope) {
        selector.scope = options.scope
      }

      await Meteor.roleAssignment.removeAsync(selector)

      // and then add all
      for (const role of roles) {
        await Roles._addUserToRole(id, role, options)
      }
    }
  },

  /**
   * Add one user to one role.
   *
   * @method _addUserToRole
   * @param {String} userId The user ID.
   * @param {String} roleName Name of the role to add the user to. The role have to exist.
   * @param {Object} options Options:
   *   - `scope`: name of the scope, or `null` for the global role
   *   - `ifExists`: if `true`, do not throw an exception if the role does not exist
   * @returns {Promise}
   * @private
   * @static
   */
  _addUserToRoleAsync: async function (userId, roleName, options) {
    Roles._checkRoleName(roleName)
    Roles._checkScopeName(options.scope)

    if (!userId) {
      return
    }

    const role = await Meteor.roles.findOneAsync(
      { _id: roleName },
      { fields: { children: 1 } }
    )

    if (!role) {
      if (options.ifExists) {
        return []
      } else {
        throw new Error("Role '" + roleName + "' does not exist.")
      }
    }

    // This might create duplicates, because we don't have a unique index, but that's all right. In case there are two, withdrawing the role will effectively kill them both.
    const existingAssignment = await Meteor.roleAssignment.findOneAsync({
      'user._id': userId,
      'role._id': roleName,
      scope: options.scope
    })

    let insertedId
    let res
    if (existingAssignment) {
      await Meteor.roleAssignment.updateAsync(existingAssignment._id, {
        $set: {
          user: { _id: userId },
          role: { _id: roleName },
          scope: options.scope
        }
      })

      res = await Meteor.roleAssignment.findOneAsync(existingAssignment._id)
    } else {
      insertedId = await Meteor.roleAssignment.insertAsync({
        user: { _id: userId },
        role: { _id: roleName },
        scope: options.scope
      })
    }
    /* const res = await Meteor.roleAssignment.upsertAsync(
      {
        "user._id": userId,
        "role._id": roleName,
        scope: options.scope,
      },
      {
        $setOnInsert: {
          user: { _id: userId },
          role: { _id: roleName },
          scope: options.scope,
        },
      }
    ); */

    if (insertedId) {
      await Meteor.roleAssignment.updateAsync(
        { _id: insertedId },
        {
          $set: {
            inheritedRoles: [
              roleName,
              ...(await Roles._getInheritedRoleNamesAsync(role))
            ].map((r) => ({ _id: r }))
          }
        }
      )

      res = await Meteor.roleAssignment.findOneAsync({ _id: insertedId })
    }

    return res
  },

  /**
   * Returns an array of role names the given role name is a child of.
   *
   * @example
   *     Roles._getParentRoleNames({ _id: 'admin', children; [] })
   *
   * @method _getParentRoleNames
   * @param {object} role The role object
   * @returns {Promise}
   * @private
   * @static
   */
  _getParentRoleNamesAsync: async function (role) {
    if (!role) {
      return []
    }

    const parentRoles = new Set([role._id])

    for (const roleName of parentRoles) {
      for (const parentRole of await Meteor.roles
        .find({ 'children._id': roleName })
        .fetchAsync()) {
        parentRoles.add(parentRole._id)
      }
    }

    parentRoles.delete(role._id)

    return [...parentRoles]
  },

  /**
   * Returns an array of role names the given role name is a parent of.
   *
   * @example
   *     Roles._getInheritedRoleNames({ _id: 'admin', children; [] })
   *
   * @method _getInheritedRoleNames
   * @param {object} role The role object
   * @returns {Promise}
   * @private
   * @static
   */
  _getInheritedRoleNamesAsync: async function (role) {
    const inheritedRoles = new Set()
    const nestedRoles = new Set([role])

    for (const r in nestedRoles) {
      const roles = await Meteor.roles
        .find(
          { _id: { $in: r.children.map((r) => r._id) } },
          { fields: { children: 1 } }
        )
        .fetchAsync()

      for (const r2 of roles) {
        inheritedRoles.add(r2._id)
        nestedRoles.add(r2)
      }
    }

    return [...inheritedRoles]
  },

  /**
   * Remove users from assigned roles.
   *
   * @example
   *     Roles.removeUsersFromRoles(userId, 'admin')
   *     Roles.removeUsersFromRoles([userId, user2], ['editor'])
   *     Roles.removeUsersFromRoles(userId, ['user'], 'group1')
   *
   * @method removeUsersFromRoles
   * @param {Array|String} users User ID(s) or object(s) with an `_id` field.
   * @param {Array|String} roles Name(s) of roles to remove users from. Roles have to exist.
   * @param {Object|String} [options] Options:
   *   - `scope`: name of the scope, or `null` for the global role
   *   - `anyScope`: if set, role can be in any scope (`scope` option is ignored)
   * @returns {Promise}
   *
   * Alternatively, it can be a scope name string.
   * @static
   */
  removeUsersFromRolesAsync: async function (users, roles, options) {
    if (!users) throw new Error("Missing 'users' param.")
    if (!roles) throw new Error("Missing 'roles' param.")

    options = Roles._normalizeOptions(options)

    // ensure arrays
    if (!Array.isArray(users)) users = [users]
    if (!Array.isArray(roles)) roles = [roles]

    Roles._checkScopeName(options.scope)

    for (const user of users) {
      if (!user) return

      for (const role of roles) {
        let id
        if (typeof user === 'object') {
          id = user._id
        } else {
          id = user
        }

        await Roles._removeUserFromRoleAsync(id, role, options)
      }
    }
  },

  /**
   * Remove one user from one role.
   *
   * @method _removeUserFromRole
   * @param {String} userId The user ID.
   * @param {String} roleName Name of the role to add the user to. The role have to exist.
   * @param {Object} options Options:
   *   - `scope`: name of the scope, or `null` for the global role
   *   - `anyScope`: if set, role can be in any scope (`scope` option is ignored)
   * @returns {Promise}
   * @private
   * @static
   */
  _removeUserFromRoleAsync: async function (userId, roleName, options) {
    Roles._checkRoleName(roleName)
    Roles._checkScopeName(options.scope)

    if (!userId) return

    const selector = {
      'user._id': userId,
      'role._id': roleName
    }

    if (!options.anyScope) {
      selector.scope = options.scope
    }

    await Meteor.roleAssignment.removeAsync(selector)
  },

  /**
   * Check if user has specified roles.
   *
   * @example
   *     // global roles
   *     Roles.userIsInRole(user, 'admin')
   *     Roles.userIsInRole(user, ['admin','editor'])
   *     Roles.userIsInRole(userId, 'admin')
   *     Roles.userIsInRole(userId, ['admin','editor'])
   *
   *     // scope roles (global roles are still checked)
   *     Roles.userIsInRole(user, 'admin', 'group1')
   *     Roles.userIsInRole(userId, ['admin','editor'], 'group1')
   *     Roles.userIsInRole(userId, ['admin','editor'], {scope: 'group1'})
   *
   * @method userIsInRole
   * @param {String|Object} user User ID or an actual user object.
   * @param {Array|String} roles Name of role or an array of roles to check against. If array,
   *                             will return `true` if user is in _any_ role.
   *                             Roles do not have to exist.
   * @param {Object|String} [options] Options:
   *   - `scope`: name of the scope; if supplied, limits check to just that scope
   *     the user's global roles will always be checked whether scope is specified or not
   *   - `anyScope`: if set, role can be in any scope (`scope` option is ignored)
   *
   * Alternatively, it can be a scope name string.
   * @return {Promise<Boolean>} `true` if user is in _any_ of the target roles
   * @static
   */
  userIsInRoleAsync: async function (user, roles, options) {
    let id

    options = Roles._normalizeOptions(options)

    // ensure array to simplify code
    if (!Array.isArray(roles)) roles = [roles]

    roles = roles.filter((r) => r != null)

    if (!roles.length) return false

    Roles._checkScopeName(options.scope)

    options = Object.assign(
      {
        anyScope: false
      },
      options
    )

    if (user && typeof user === 'object') {
      id = user._id
    } else {
      id = user
    }

    if (!id) return false
    if (typeof id !== 'string') return false

    const selector = {
      'user._id': id
    }

    if (!options.anyScope) {
      selector.scope = { $in: [options.scope, null] }
    }

    const res = await asyncSome(roles, async (roleName) => {
      selector['inheritedRoles._id'] = roleName
      const out =
        (await Meteor.roleAssignment
          .find(selector, { limit: 1 })
          .countAsync()) > 0
      return out
    })

    return res
  },

  /**
   * Retrieve user's roles.
   *
   * @method getRolesForUser
   * @param {String|Object} user User ID or an actual user object.
   * @param {Object|String} [options] Options:
   *   - `scope`: name of scope to provide roles for; if not specified, global roles are returned
   *   - `anyScope`: if set, role can be in any scope (`scope` and `onlyAssigned` options are ignored)
   *   - `onlyScoped`: if set, only roles in the specified scope are returned
   *   - `onlyAssigned`: return only assigned roles and not automatically inferred (like subroles)
   *   - `fullObjects`: return full roles objects (`true`) or just names (`false`) (`onlyAssigned` option is ignored) (default `false`)
   *     If you have a use-case for this option, please file a feature-request. You shouldn't need to use it as it's
   *     result strongly dependant on the internal data structure of this plugin.
   *
   * Alternatively, it can be a scope name string.
   * @return {Promise<Array>} Array of user's roles, unsorted.
   * @static
   */
  getRolesForUserAsync: async function (user, options) {
    let id

    options = Roles._normalizeOptions(options)

    Roles._checkScopeName(options.scope)

    options = Object.assign(
      {
        fullObjects: false,
        onlyAssigned: false,
        anyScope: false,
        onlyScoped: false
      },
      options
    )

    if (user && typeof user === 'object') {
      id = user._id
    } else {
      id = user
    }

    if (!id) return []

    const selector = {
      'user._id': id
    }

    const filter = {
      fields: { 'inheritedRoles._id': 1 }
    }

    if (!options.anyScope) {
      selector.scope = { $in: [options.scope] }

      if (!options.onlyScoped) {
        selector.scope.$in.push(null)
      }
    }

    if (options.onlyAssigned) {
      delete filter.fields['inheritedRoles._id']
      filter.fields['role._id'] = 1
    }

    if (options.fullObjects) {
      delete filter.fields
    }

    const roles = await Meteor.roleAssignment.find(selector, filter).fetchAsync()

    if (options.fullObjects) {
      return roles
    }

    return [
      ...new Set(
        roles.reduce((rev, current) => {
          if (current.inheritedRoles) {
            return rev.concat(current.inheritedRoles.map((r) => r._id))
          } else if (current.role) {
            rev.push(current.role._id)
          }
          return rev
        }, [])
      )
    ]
  },

  /**
   * Retrieve cursor of all existing roles.
   *
   * @method getAllRoles
   * @param {Object} [queryOptions] Options which are passed directly
   *                                through to `Meteor.roles.find(query, options)`.
   * @return {Cursor} Cursor of existing roles.
   * @static
   */
  getAllRoles: function (queryOptions) {
    queryOptions = queryOptions || { sort: { _id: 1 } }

    return Meteor.roles.find({}, queryOptions)
  },

  /**
   * Retrieve all users who are in target role.
   *
   * Options:
   *
   * @method getUsersInRole
   * @param {Array|String} roles Name of role or an array of roles. If array, users
   *                             returned will have at least one of the roles
   *                             specified but need not have _all_ roles.
   *                             Roles do not have to exist.
   * @param {Object|String} [options] Options:
   *   - `scope`: name of the scope to restrict roles to; user's global
   *     roles will also be checked
   *   - `anyScope`: if set, role can be in any scope (`scope` option is ignored)
   *   - `onlyScoped`: if set, only roles in the specified scope are returned
   *   - `queryOptions`: options which are passed directly
   *     through to `Meteor.users.find(query, options)`
   *
   * Alternatively, it can be a scope name string.
   * @param {Object} [queryOptions] Options which are passed directly
   *                                through to `Meteor.users.find(query, options)`
   * @return {Promise<Cursor>} Cursor of users in roles.
   * @static
   */
  getUsersInRoleAsync: async function (roles, options, queryOptions) {
    const ids = (
      await Roles.getUserAssignmentsForRole(roles, options).fetchAsync()
    ).map((a) => a.user._id)

    return Meteor.users.find(
      { _id: { $in: ids } },
      (options && options.queryOptions) || queryOptions || {}
    )
  },

  /**
   * Retrieve all assignments of a user which are for the target role.
   *
   * Options:
   *
   * @method getUserAssignmentsForRole
   * @param {Array|String} roles Name of role or an array of roles. If array, users
   *                             returned will have at least one of the roles
   *                             specified but need not have _all_ roles.
   *                             Roles do not have to exist.
   * @param {Object|String} [options] Options:
   *   - `scope`: name of the scope to restrict roles to; user's global
   *     roles will also be checked
   *   - `anyScope`: if set, role can be in any scope (`scope` option is ignored)
   *   - `queryOptions`: options which are passed directly
   *     through to `Meteor.roleAssignment.find(query, options)`

   * Alternatively, it can be a scope name string.
   * @return {Cursor} Cursor of user assignments for roles.
   * @static
   */
  getUserAssignmentsForRole: function (roles, options) {
    options = Roles._normalizeOptions(options)

    options = Object.assign(
      {
        anyScope: false,
        queryOptions: {}
      },
      options
    )

    return Roles._getUsersInRoleCursor(roles, options, options.queryOptions)
  },

  /**
   * @method _getUsersInRoleCursor
   * @param {Array|String} roles Name of role or an array of roles. If array, ids of users are
   *                             returned which have at least one of the roles
   *                             assigned but need not have _all_ roles.
   *                             Roles do not have to exist.
   * @param {Object|String} [options] Options:
   *   - `scope`: name of the scope to restrict roles to; user's global
   *     roles will also be checked
   *   - `anyScope`: if set, role can be in any scope (`scope` option is ignored)
   *
   * Alternatively, it can be a scope name string.
   * @param {Object} [filter] Options which are passed directly
   *                                through to `Meteor.roleAssignment.find(query, options)`
   * @return {Object} Cursor to the assignment documents
   * @private
   * @static
   */
  _getUsersInRoleCursor: function (roles, options, filter) {
    options = Roles._normalizeOptions(options)

    options = Object.assign(
      {
        anyScope: false,
        onlyScoped: false
      },
      options
    )

    // ensure array to simplify code
    if (!Array.isArray(roles)) roles = [roles]

    Roles._checkScopeName(options.scope)

    filter = Object.assign(
      {
        fields: { 'user._id': 1 }
      },
      filter
    )

    const selector = {
      'inheritedRoles._id': { $in: roles }
    }

    if (!options.anyScope) {
      selector.scope = { $in: [options.scope] }

      if (!options.onlyScoped) {
        selector.scope.$in.push(null)
      }
    }

    return Meteor.roleAssignment.find(selector, filter)
  },

  /**
   * Deprecated. Use `getScopesForUser` instead.
   *
   * @method getGroupsForUser
   * @returns {Promise<Array>}
   * @static
   * @deprecated
   */
  getGroupsForUserAsync: async function (...args) {
    if (!getGroupsForUserDeprecationWarning) {
      getGroupsForUserDeprecationWarning = true
      console &&
        console.warn(
          'getGroupsForUser has been deprecated. Use getScopesForUser instead.'
        )
    }

    return await Roles.getScopesForUser(...args)
  },

  /**
   * Retrieve users scopes, if any.
   *
   * @method getScopesForUser
   * @param {String|Object} user User ID or an actual user object.
   * @param {Array|String} [roles] Name of roles to restrict scopes to.
   *
   * @return {Promise<Array>} Array of user's scopes, unsorted.
   * @static
   */
  getScopesForUserAsync: async function (user, roles) {
    let id

    if (roles && !Array.isArray(roles)) roles = [roles]

    if (user && typeof user === 'object') {
      id = user._id
    } else {
      id = user
    }

    if (!id) return []

    const selector = {
      'user._id': id,
      scope: { $ne: null }
    }

    if (roles) {
      selector['inheritedRoles._id'] = { $in: roles }
    }

    const scopes = (
      await Meteor.roleAssignment
        .find(selector, { fields: { scope: 1 } })
        .fetchAsync()
    ).map((obi) => obi.scope)

    return [...new Set(scopes)]
  },

  /**
   * Rename a scope.
   *
   * Roles assigned with a given scope are changed to be under the new scope.
   *
   * @method renameScope
   * @param {String} oldName Old name of a scope.
   * @param {String} newName New name of a scope.
   * @returns {Promise}
   * @static
   */
  renameScopeAsync: async function (oldName, newName) {
    let count

    Roles._checkScopeName(oldName)
    Roles._checkScopeName(newName)

    if (oldName === newName) return

    do {
      count = await Meteor.roleAssignment.updateAsync(
        {
          scope: oldName
        },
        {
          $set: {
            scope: newName
          }
        },
        { multi: true }
      )
    } while (count > 0)
  },

  /**
   * Remove a scope.
   *
   * Roles assigned with a given scope are removed.
   *
   * @method removeScope
   * @param {String} name The name of a scope.
   * @returns {Promise}
   * @static
   */
  removeScopeAsync: async function (name) {
    Roles._checkScopeName(name)

    await Meteor.roleAssignment.removeAsync({ scope: name })
  },

  /**
   * Throw an exception if `roleName` is an invalid role name.
   *
   * @method _checkRoleName
   * @param {String} roleName A role name to match against.
   * @private
   * @static
   */
  _checkRoleName: function (roleName) {
    if (
      !roleName ||
      typeof roleName !== 'string' ||
      roleName.trim() !== roleName
    ) {
      throw new Error("Invalid role name '" + roleName + "'.")
    }
  },

  /**
   * Find out if a role is an ancestor of another role.
   *
   * WARNING: If you check this on the client, please make sure all roles are published.
   *
   * @method isParentOf
   * @param {String} parentRoleName The role you want to research.
   * @param {String} childRoleName The role you expect to be among the children of parentRoleName.
   * @returns {Promise}
   * @static
   */
  isParentOfAsync: async function (parentRoleName, childRoleName) {
    if (parentRoleName === childRoleName) {
      return true
    }

    if (parentRoleName == null || childRoleName == null) {
      return false
    }

    Roles._checkRoleName(parentRoleName)
    Roles._checkRoleName(childRoleName)

    let rolesToCheck = [parentRoleName]
    while (rolesToCheck.length !== 0) {
      const roleName = rolesToCheck.pop()

      if (roleName === childRoleName) {
        return true
      }

      const role = await Meteor.roles.findOneAsync({ _id: roleName })

      // This should not happen, but this is a problem to address at some other time.
      if (!role) continue

      rolesToCheck = rolesToCheck.concat(role.children.map((r) => r._id))
    }

    return false
  },

  /**
   * Normalize options.
   *
   * @method _normalizeOptions
   * @param {Object} options Options to normalize.
   * @return {Object} Normalized options.
   * @private
   * @static
   */
  _normalizeOptions: function (options) {
    options = options === undefined ? {} : options

    if (options === null || typeof options === 'string') {
      options = { scope: options }
    }

    options.scope = Roles._normalizeScopeName(options.scope)

    return options
  },

  /**
   * Normalize scope name.
   *
   * @method _normalizeScopeName
   * @param {String} scopeName A scope name to normalize.
   * @return {String} Normalized scope name.
   * @private
   * @static
   */
  _normalizeScopeName: function (scopeName) {
    // map undefined and null to null
    if (scopeName == null) {
      return null
    } else {
      return scopeName
    }
  },

  /**
   * Throw an exception if `scopeName` is an invalid scope name.
   *
   * @method _checkRoleName
   * @param {String} scopeName A scope name to match against.
   * @private
   * @static
   */
  _checkScopeName: function (scopeName) {
    if (scopeName === null) return

    if (
      !scopeName ||
      typeof scopeName !== 'string' ||
      scopeName.trim() !== scopeName
    ) {
      throw new Error("Invalid scope name '" + scopeName + "'.")
    }
  }
})
