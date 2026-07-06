/**
 * Qoder 租户凭证管理
 *
 * 与 codebuddy 的差异：
 * - Qoder 没有 OAuth 刷新流程，bearer_token 是长期 PAT
 * - 没有 user_info / enterprise_id / department_info 等字段
 * - 多了一个 backend 字段（cn / global）
 * - 不需要 blocked_domains 自动禁用逻辑
 *
 * 因此独立实现，比 TenantTokenManager 简单很多。
 *
 * @module services/qoder/tenant-token-manager
 */

import logger from '../../utils/logger.js';
import {models} from '../../db/models/index.js';
import {sequelize} from '../../db/index.js';

class TenantTokenManager {
    /**
     * @param {string|null} _tenantDir - 兼容旧调用，忽略
     * @param {Object} [options]
     * @param {number} [options.tenantId] - 数据库 tenant 主键
     */
    constructor(_tenantDir, options = {}) {
        this.tenantDir = _tenantDir;
        this.tenantId = options.tenantId;

        this.credentials = [];
        this.currentIndex = 0;
        this.disabledIndexes = [];

        // 会话亲和性：conversationId → { index, lastAccess }
        // 同一会话始终使用同一 PAT，避免凭证切换导致 KV Cache miss
        this.sessionAffinity = new Map();
    }

    static SESSION_AFFINITY_TTL = 30 * 60 * 1000;

    async init() {
        await this.loadAllTokens();
        await this.loadState();
    }

    static async create(tenantDir, options = {}) {
        const instance = new TenantTokenManager(tenantDir, options);
        await instance.init();
        return instance;
    }

    _mapRecordToData(record) {
        return {
            name: record.name || '',
            bearer_token: record.bearer_token || '',
            backend: record.backend || 'cn',
            base_url: record.base_url || '',
            user_id: record.user_id || '',
            credential_created_at: record.credential_created_at || null
        };
    }

    _mapDataToRecord(data) {
        const backend = data.backend || 'cn';
        // 向后兼容：'intl' 映射为 'intl'（DB 已支持），'global' 也保留
        return {
            tenant_id: this.tenantId,
            name: data.name || null,
            bearer_token: data.bearer_token,
            backend: ['cn', 'intl', 'global'].includes(backend) ? backend : 'cn',
            base_url: data.base_url || null,
            user_id: data.user_id || null,
            enabled: data.enabled !== false,
            is_active: !!data.is_active,
            sort_order: typeof data.sort_order === 'number' ? data.sort_order : 0,
            credential_created_at: data.created_at || data.credential_created_at || Math.floor(Date.now() / 1000)
        };
    }

    async loadAllTokens() {
        this.credentials = [];
        this.currentIndex = 0;

        logger.debug(`Loading Qoder credentials from DB for tenant_id: ${this.tenantId}`);

        try {
            // 去重：DB 中历史遗留的重复凭证（同一 tenant_id + bearer_token）合并保留最早一条
            const dupRecords = await models.TenantQoderCredential.findAll({
                where: {tenant_id: this.tenantId},
                attributes: ['bearer_token', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
                group: ['bearer_token'],
                having: sequelize.literal('count > 1'),
                raw: true
            });
            for (const dup of dupRecords) {
                const records = await models.TenantQoderCredential.findAll({
                    where: {tenant_id: this.tenantId, bearer_token: dup.bearer_token},
                    order: [['id', 'ASC']]
                });
                const keepId = records[0].id;
                const removeIds = records.slice(1).map(r => r.id);
                if (removeIds.length) {
                    await models.TenantQoderCredential.destroy({where: {id: removeIds}});
                    logger.warn(`Qoder 去重: 移除 tenant_id=${this.tenantId} 的 ${removeIds.length} 条重复凭证 (bearer_token 前缀=${String(dup.bearer_token).slice(0, 6)}...)`);
                }
            }

            const records = await models.TenantQoderCredential.findAll({
                where: {tenant_id: this.tenantId},
                order: [['sort_order', 'ASC'], ['id', 'ASC']]
            });

            for (const record of records) {
                this.credentials.push({
                    id: record.id,
                    data: this._mapRecordToData(record),
                    disabled: !record.enabled
                });
            }

            logger.debug(`Loaded ${this.credentials.length} Qoder credentials`);
        } catch (error) {
            logger.error(`Failed to load Qoder credentials from DB: ${error.message}`);
        }
    }

    async loadState() {
        try {
            const state = await models.TenantState.findOne({
                where: {tenant_id: this.tenantId}
            });

            if (!state) return;

            const savedDisabledIndexes = state.disabled_indexes;
            if (Array.isArray(savedDisabledIndexes)) {
                this.disabledIndexes = savedDisabledIndexes
                    .filter((i) => i >= 0 && i < this.credentials.length);
            }

            if (state.current_index !== undefined && state.current_index >= 0
                && state.current_index < this.credentials.length) {
                this.currentIndex = state.current_index;
            }
        } catch (error) {
            logger.warn(`Failed to load Qoder manager state: ${error.message}`);
        }
    }

    async saveState() {
        try {
            await models.TenantState.upsert({
                tenant_id: this.tenantId,
                current_index: this.currentIndex,
                disabled_indexes: this.disabledIndexes,
                saved_at: String(Date.now())
            });
        } catch (error) {
            logger.error(`Failed to save Qoder manager state: ${error.message}`);
        }
    }

    /**
     * 获取当前可用凭证
     * @param {string} [conversationId] - 用于会话亲和性绑定
     * @returns {Object|null} {name, bearer_token, backend}
     */
    async getNextCredential(conversationId) {
        if (this.credentials.length === 0) return null;

        await this._reloadCurrentIndex();
        this._cleanupSessionAffinity();

        // 会话亲和性优先
        if (conversationId) {
            const affinity = this.sessionAffinity.get(conversationId);
            if (affinity) {
                const cred = this.credentials[affinity.index];
                if (cred && !this.disabledIndexes.includes(affinity.index) && cred.data.bearer_token) {
                    affinity.lastAccess = Date.now();
                    logger.debug(`Qoder session affinity hit: conversationId=${conversationId}, index=${affinity.index}`);
                    return cred.data;
                }
                this.sessionAffinity.delete(conversationId);
            }
        }

        // 当前凭证不可用 → 切换
        if (this.currentIndex < 0 || this.currentIndex >= this.credentials.length
            || this.disabledIndexes.includes(this.currentIndex)) {
            const nextAvailable = this.credentials.findIndex(
                (_, i) => !this.disabledIndexes.includes(i) && !!this.credentials[i].data.bearer_token
            );
            if (nextAvailable === -1) return null;
            this.currentIndex = nextAvailable;
        }

        const credential = this.credentials[this.currentIndex];
        if (conversationId) {
            this.sessionAffinity.set(conversationId, {index: this.currentIndex, lastAccess: Date.now()});
        }

        return credential.data;
    }

    async _reloadCurrentIndex() {
        try {
            const dbCredentialCount = await models.TenantQoderCredential.count({
                where: {tenant_id: this.tenantId}
            });
            if (dbCredentialCount !== this.credentials.length) {
                logger.info(`Qoder TenantTokenManager: 凭证数量变化 (内存=${this.credentials.length}, DB=${dbCredentialCount})，重新加载`);
                this.sessionAffinity.clear();
                await this.loadAllTokens();
                await this.loadState();
                return;
            }

            const state = await models.TenantState.findOne({
                where: {tenant_id: this.tenantId}
            });
            if (state && state.current_index !== undefined) {
                const newIndex = state.current_index;
                if (newIndex >= 0 && newIndex < this.credentials.length
                    && !this.disabledIndexes.includes(newIndex)
                    && this.currentIndex !== newIndex) {
                    logger.info(`Qoder currentIndex 从 ${this.currentIndex} 更新为 ${newIndex}`);
                    this.currentIndex = newIndex;
                }
            }
        } catch (error) {
            logger.warn(`Qoder _reloadCurrentIndex 失败: ${error.message}`);
        }
    }

    _cleanupSessionAffinity() {
        if (this.sessionAffinity.size === 0) return;
        const now = Date.now();
        for (const [convId, affinity] of this.sessionAffinity) {
            if (now - affinity.lastAccess > TenantTokenManager.SESSION_AFFINITY_TTL) {
                this.sessionAffinity.delete(convId);
            }
        }
    }

    async addCredentialWithData(credentialData) {
        if (!credentialData.bearer_token) {
            logger.error('addCredentialWithData: bearer_token 必填');
            return false;
        }
        if (!credentialData.created_at) {
            credentialData.created_at = Math.floor(Date.now() / 1000);
        }

        try {
            // 去重：相同 (tenant_id, bearer_token) 的凭证不重复插入
            const existing = await models.TenantQoderCredential.findOne({
                where: {
                    tenant_id: this.tenantId,
                    bearer_token: credentialData.bearer_token
                }
            });
            if (existing) {
                logger.info(`addCredentialWithData: 凭证已存在 (id=${existing.id})，跳过插入`);
                // 同步到内存（如果还没加载）
                if (!this.credentials.some(c => c.id === existing.id)) {
                    this.credentials.push({
                        id: existing.id,
                        data: this._mapRecordToData(existing),
                        disabled: !existing.enabled
                    });
                }
                return true;
            }

            const recordFields = this._mapDataToRecord(credentialData);
            recordFields.sort_order = this.credentials.length;
            const record = await models.TenantQoderCredential.create(recordFields);
            this.credentials.push({
                id: record.id,
                data: this._mapRecordToData(record),
                disabled: !record.enabled
            });
            logger.debug(`Added Qoder credential: id=${record.id}, backend=${record.backend}`);
            return true;
        } catch (error) {
            logger.error(`Failed to save Qoder credential: ${error.message}`);
            return false;
        }
    }

    async deleteCredential(index) {
        try {
            if (index < 0 || index >= this.credentials.length) {
                logger.error(`Invalid Qoder credential index: ${index}`);
                return false;
            }

            const cred = this.credentials[index];
            await models.TenantQoderCredential.destroy({where: {id: cred.id}});

            this.disabledIndexes = this.disabledIndexes
                .filter((i) => i !== index)
                .map((i) => (i > index ? i - 1 : i));

            if (this.currentIndex === index) this.currentIndex = 0;
            else if (this.currentIndex > index) this.currentIndex--;

            this.sessionAffinity.clear();
            this.credentials.splice(index, 1);
            await this.saveState();
            return true;
        } catch (error) {
            logger.error(`Failed to delete Qoder credential: ${error.message}`);
            return false;
        }
    }

    async setActiveCredential(index) {
        if (index >= 0 && index < this.credentials.length) {
            this.currentIndex = index;
            this.sessionAffinity.clear();
            await this.saveState();
            return true;
        }
        logger.error(`Invalid Qoder credential index for active: ${index}`);
        return false;
    }

    async toggleCredentialDisable(index) {
        if (index < 0 || index >= this.credentials.length) {
            return {disabled: false};
        }

        const cred = this.credentials[index];
        const newDisabled = !this.disabledIndexes.includes(index);

        if (newDisabled) {
            this.disabledIndexes.push(index);
            if (this.currentIndex === index) {
                const nextAvailable = this.credentials.findIndex(
                    (_, i) => !this.disabledIndexes.includes(i) && !!this.credentials[i].data.bearer_token
                );
                this.currentIndex = nextAvailable >= 0 ? nextAvailable : 0;
                this.sessionAffinity.clear();
            }
        } else {
            const pos = this.disabledIndexes.indexOf(index);
            if (pos >= 0) this.disabledIndexes.splice(pos, 1);
        }

        try {
            await models.TenantQoderCredential.update(
                {enabled: !newDisabled},
                {where: {id: cred.id}}
            );
        } catch (error) {
            logger.error(`Failed to update Qoder credential enabled flag: ${error.message}`);
        }

        await this.saveState();
        return {disabled: newDisabled};
    }

    getCredentialsInfo() {
        return this.credentials.map((cred, index) => ({
            index,
            id: cred.id,
            name: cred.data.name || '',
            backend: cred.data.backend,
            base_url: cred.data.base_url || '',
            user_id: cred.data.user_id || '',
            credential_created_at: cred.data.credential_created_at || null,
            enabled: !this.disabledIndexes.includes(index),
            hasToken: !!cred.data.bearer_token,
            tokenPreview: cred.data.bearer_token
                ? `${cred.data.bearer_token.slice(0, 4)}...${cred.data.bearer_token.slice(-4)}`
                : ''
        }));
    }

    getCurrentCredentialInfo() {
        if (this.credentials.length === 0) return {status: 'no_credentials'};
        if (this.currentIndex < 0 || this.currentIndex >= this.credentials.length) this.currentIndex = 0;
        const credential = this.credentials[this.currentIndex];
        return {
            status: 'active',
            index: this.currentIndex,
            id: credential.id,
            backend: credential.data.backend
        };
    }

    hasCredentials() {
        return this.credentials.length > 0;
    }

    ensureDirExists() {
        // DB 模式下无需创建目录
    }
}

export {TenantTokenManager};