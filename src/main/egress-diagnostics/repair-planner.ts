import {
  type EgressProcessPolicyRevision,
  type EgressProcessPolicySnapshot,
  type EgressProcessPolicyStorePort,
} from './process-policy-store';
import {
  applyEgressProcessPolicyEdits,
  buildEgressProcessEnvironmentPlan,
  cloneEgressProcessPolicy,
  EGRESS_REPAIR_ACTIVATIONS,
  egressProcessPoliciesEqual,
  egressRepairActivationsForField,
  type EgressProcessEnvironmentPlan,
  type EgressProcessPolicy,
  type EgressProcessPolicyEdits,
  type EgressProcessPolicyField,
  type EgressProcessPolicyFieldValue,
  type EgressRepairActivation,
  type EgressRepairChange,
  normalizeEgressProcessPolicyEdits,
} from './process-policy-types';

export interface EgressRepairPlan {
  readonly activationRequirements: readonly EgressRepairActivation[];
  readonly after: EgressProcessPolicy;
  readonly before: EgressProcessPolicy;
  readonly changes: readonly EgressRepairChange[];
  /** Revision the apply request must still observe before it can write. */
  readonly expectedRevision: EgressProcessPolicyRevision;
  readonly processEnvironment: EgressProcessEnvironmentPlan;
  /** Opaque revision expected after the policy write succeeds. */
  readonly resultingRevision: EgressProcessPolicyRevision;
}

interface FieldCapture {
  readonly field: EgressProcessPolicyField;
  readonly read: (policy: EgressProcessPolicy) => EgressProcessPolicyFieldValue;
}

const FIELDS: readonly FieldCapture[] = Object.freeze([
  { field: 'timezone', read: (policy) => policy.timezone },
  { field: 'request-languages', read: (policy) => policy.requestLanguages },
  { field: 'application-languages', read: (policy) => policy.applicationLanguages },
  { field: 'web-rtc', read: (policy) => policy.webRtc },
]);

const cloneFieldValue = (value: EgressProcessPolicyFieldValue): EgressProcessPolicyFieldValue =>
  structuredClone(value) as EgressProcessPolicyFieldValue;

const fieldValuesEqual = (
  first: EgressProcessPolicyFieldValue,
  second: EgressProcessPolicyFieldValue,
): boolean => JSON.stringify(first) === JSON.stringify(second);

const computeChanges = (
  before: EgressProcessPolicy,
  after: EgressProcessPolicy,
): readonly EgressRepairChange[] =>
  Object.freeze(
    FIELDS.flatMap(({ field, read }) => {
      const beforeValue = read(before);
      const afterValue = read(after);
      if (fieldValuesEqual(beforeValue, afterValue)) return [];
      return [
        Object.freeze({
          activationRequirements: egressRepairActivationsForField(field),
          after: cloneFieldValue(afterValue),
          before: cloneFieldValue(beforeValue),
          field,
        }),
      ];
    }),
  );

const aggregateActivations = (
  changes: readonly EgressRepairChange[],
): readonly EgressRepairActivation[] => {
  const requested = new Set(changes.flatMap((change) => change.activationRequirements));
  return Object.freeze(EGRESS_REPAIR_ACTIVATIONS.filter((activation) => requested.has(activation)));
};

export const planEgressProcessPolicyRepair = (
  snapshot: EgressProcessPolicySnapshot,
  edits: EgressProcessPolicyEdits,
  revisionFor: (policy: EgressProcessPolicy) => EgressProcessPolicyRevision,
): EgressRepairPlan => {
  const requested = normalizeEgressProcessPolicyEdits(edits);
  const before = cloneEgressProcessPolicy(snapshot.policy);
  const candidate = applyEgressProcessPolicyEdits(before, requested);
  const after = egressProcessPoliciesEqual(before, candidate)
    ? cloneEgressProcessPolicy(before)
    : cloneEgressProcessPolicy(candidate);
  const changes = computeChanges(before, after);
  return Object.freeze({
    activationRequirements: aggregateActivations(changes),
    after,
    before,
    changes,
    expectedRevision: snapshot.revision,
    processEnvironment: buildEgressProcessEnvironmentPlan(after),
    resultingRevision: revisionFor(after),
  });
};

/** Pure dry-run planner apart from bounded policy reads and keyed revision calculation. */
export class EgressRepairPlanner {
  public constructor(private readonly store: EgressProcessPolicyStorePort) {}

  public plan(edits: EgressProcessPolicyEdits): EgressRepairPlan {
    return planEgressProcessPolicyRepair(this.store.read(), edits, (policy) =>
      this.store.revisionFor(policy),
    );
  }
}
