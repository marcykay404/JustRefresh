import { Registry } from "./registry";
import type { ActionHandler, ConditionHandler, TriggerHandler } from "./contracts";
import { domAttribute, domChanged, domExists, domMissing, domText, domTextLost } from "../conditions/dom";
import { urlMatch } from "../conditions/url-match";
import { timeAfter, timeBefore } from "../conditions/time";
import { refreshCount, tabStatus } from "../conditions/runtime";
import { allCondition, anyCondition, notCondition } from "../conditions/logical";
import { intervalTrigger } from "../triggers/interval";
import { manualTrigger, navigationTrigger, startupTrigger, urlChangeTrigger } from "../triggers/navigation";
import { logAction, notifyAction, pauseAction, refreshAction, resumeAction, stopAction } from "../actions/builtin";
import { clickAction, highlightAction, webhookAction } from "../actions/page";

export type ConditionRegistry = Registry<ConditionHandler<any>>;
export type TriggerRegistry = Registry<TriggerHandler<any>>;
export type ActionRegistry = Registry<ActionHandler<any>>;

export interface Registries {
  conditions: ConditionRegistry;
  triggers: TriggerRegistry;
  actions: ActionRegistry;
}

export function createConditionRegistry(): ConditionRegistry {
  return new Registry<ConditionHandler<any>>("Condition")
    .register(domExists)
    .register(domMissing)
    .register(domText)
    .register(domAttribute)
    .register(domChanged)
    .register(domTextLost)
    .register(urlMatch)
    .register(timeAfter)
    .register(timeBefore)
    .register(refreshCount)
    .register(tabStatus)
    .register(allCondition)
    .register(anyCondition)
    .register(notCondition);
}

export function createTriggerRegistry(): TriggerRegistry {
  return new Registry<TriggerHandler<any>>("Trigger")
    .register(intervalTrigger)
    .register(navigationTrigger)
    .register(urlChangeTrigger)
    .register(startupTrigger)
    .register(manualTrigger);
}

export function createActionRegistry(): ActionRegistry {
  return new Registry<ActionHandler<any>>("Action")
    .register(refreshAction)
    .register(stopAction)
    .register(pauseAction)
    .register(resumeAction)
    .register(notifyAction)
    .register(logAction)
    .register(clickAction)
    .register(highlightAction)
    .register(webhookAction);
}

export function createRegistries(): Registries {
  return {
    conditions: createConditionRegistry(),
    triggers: createTriggerRegistry(),
    actions: createActionRegistry(),
  };
}

let defaults: Registries | null = null;
export function defaultRegistries(): Registries {
  return (defaults ??= createRegistries());
}
