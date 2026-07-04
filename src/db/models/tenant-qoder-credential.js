import {DataTypes} from 'sequelize';
import {sequelize} from '../index.js';

/**
 * Qoder 渠道凭证（Personal Access Token）
 *
 * Qoder CLI 通过环境变量接收 PAT，与 Codebuddy 的 OAuth 流程差异较大，
 * 故独立成表（参考 TenantCopilotCredential 的设计）。
 *
 * 每个租户可配置多个 PAT，调用时按会话亲和性复用同一凭证以提升 KV Cache 命中。
 */
export const TenantQoderCredential = sequelize.define('tenant_qoder_credentials', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    tenant_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    name: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: '凭证别名（仅作显示用途）'
    },
    bearer_token: {
        type: DataTypes.TEXT,
        allowNull: false,
        comment: 'Qoder Personal Access Token'
    },
    backend: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'cn',
        validate: {
            isIn: [['cn', 'global']]
        },
        comment: 'CLI 后端：cn=国内版, global=国际版'
    },
    enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true
    },
    is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
    },
    sort_order: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    }
}, {
    indexes: [
        {fields: ['tenant_id']},
        {fields: ['tenant_id', 'enabled']},
        {fields: ['tenant_id', 'is_active']}
    ]
});