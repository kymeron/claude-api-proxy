import test from 'node:test';
import assert from 'node:assert/strict';

import {
    listManagedUsers,
    updateManagedUser,
    deleteManagedUser
} from '../src/services/shared/local-user-manager.js';
import {models} from '../src/db/models/index.js';

function tenantRow(data) {
    return {
        created_at: data.created_at || new Date('2026-06-01T00:00:00Z'),
        ...data
    };
}

test('LDAP mode lists LDAP tenant users instead of local password users', async () => {
    const originalFindAll = models.Tenant.findAll;
    const whereClauses = [];

    models.Tenant.findAll = async (options = {}) => {
        whereClauses.push(options.where);
        return [
            tenantRow({username: 'ldap-user', name: 'LDAP User', role: 'user', password_hash: null})
        ];
    };

    try {
        const users = await listManagedUsers('admin', 'ldap');
        assert.deepEqual(whereClauses, [{password_hash: null}]);
        assert.deepEqual(users.map(u => ({
            username: u.username,
            displayName: u.displayName,
            role: u.role,
            source: u.source
        })), [{
            username: 'ldap-user',
            displayName: 'LDAP User',
            role: 'user',
            source: 'ldap'
        }]);
    } finally {
        models.Tenant.findAll = originalFindAll;
    }
});

test('LDAP mode updates display name and role without requiring a local password', async () => {
    const originalFindOne = models.Tenant.findOne;
    const originalUpdate = models.Tenant.update;
    const updates = [];

    models.Tenant.findOne = async () => tenantRow({
        username: 'ldap-user',
        name: 'Old Name',
        role: 'user',
        password_hash: null
    });
    models.Tenant.update = async (values, options) => {
        updates.push({values, where: options.where});
        return [1];
    };

    try {
        const result = await updateManagedUser('ldap-user', {displayName: 'New Name', role: 'admin'}, 'superadmin', 'ldap');
        assert.equal(result.ok, true);
        assert.deepEqual(updates, [{
            values: {name: 'New Name', role: 'admin'},
            where: {username: 'ldap-user', password_hash: null}
        }]);
    } finally {
        models.Tenant.findOne = originalFindOne;
        models.Tenant.update = originalUpdate;
    }
});

test('LDAP mode deletes LDAP users without matching local password rows', async () => {
    const originalFindOne = models.Tenant.findOne;
    const originalDestroy = models.Tenant.destroy;
    const destroys = [];

    models.Tenant.findOne = async () => tenantRow({
        username: 'ldap-user',
        name: 'LDAP User',
        role: 'user',
        password_hash: null
    });
    models.Tenant.destroy = async (options) => {
        destroys.push(options.where);
        return 1;
    };

    try {
        const result = await deleteManagedUser('ldap-user', 'admin-user', 'admin', 'ldap');
        assert.equal(result.ok, true);
        assert.deepEqual(destroys, [{username: 'ldap-user', password_hash: null}]);
    } finally {
        models.Tenant.findOne = originalFindOne;
        models.Tenant.destroy = originalDestroy;
    }
});
