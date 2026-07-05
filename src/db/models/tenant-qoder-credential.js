import {DataTypes} from 'sequelize';
import {sequelize} from '../index.js';

/**
 * Qoder 渠道凭证（Personal Access Token / OAuth2 Token）
 *
 * 支持 PAT 手动添加和 OAuth2 浏览器登录两种方式。
 * 每个租户可配置多个凭证，调用时按会话亲和性复用同一凭证以提升 KV Cache 命中。
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
        comment: 'Qoder Personal Access Token 或 OAuth2 access_token'
    },
    backend: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'cn',
        validate: {
            isIn: [['cn', 'intl', 'global']]
        },
        comment: 'CLI 后端：cn=国内版, intl/global=国际版'
    },
    base_url: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: '凭证来源站点 URL（OAuth 登录时自动填充）'
    },
    user_id: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: '用户标识（email / preferred_username / sub）'
    },
    credential_created_at: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '凭证创建时间（Unix 秒）'
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