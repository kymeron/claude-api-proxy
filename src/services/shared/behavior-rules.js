import {getBehaviorRules} from '../../config/system-prompts.js';
import {injectBehaviorRules as injectProtocolBehaviorRules} from '../../core/protocol/index.js';

export function injectBehaviorRules(messages, modelId, options = {}) {
    return injectProtocolBehaviorRules(messages, modelId, {
        ...options,
        behaviorRules: options.behaviorRules ?? getBehaviorRules()
    });
}
