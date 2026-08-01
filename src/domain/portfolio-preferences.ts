import { z } from "zod";

import {
  SHAPING_PHASES,
  type ShapingPhase,
} from "./shaping";
import type {
  ShapingProductionReceipt,
  ShapingRunRecordV1,
} from "./shaping-run";

export const PORTFOLIO_PREFERENCES_SCHEMA_VERSION = 1 as const;
export const SHAPING_MODEL_SEATS = SHAPING_PHASES;

export type ShapingModelSeat = ShapingPhase;

const exactNonEmptyStringSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) => value === value.trim(),
    "must not have leading or trailing whitespace",
  )
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "must not contain control characters",
  );

export interface AdapterSeatModelPreferences {
  brainstorm?: string;
  spec?: string;
  plan?: string;
}

export interface PortfolioPreferencesV1 {
  schema_version: 1;
  preferences: Record<string, AdapterSeatModelPreferences>;
}

export interface SetSeatModelPreferenceInput {
  adapter_id: string;
  seat: ShapingModelSeat;
  requested_model: string;
}

export interface WorkflowShapingProduction {
  seat: ShapingModelSeat;
  receipt: ShapingProductionReceipt;
}

export interface WorkflowModelUse {
  seat: ShapingModelSeat;
  production_id: string;
  shaping_run_id: string | null;
  requested_model: string | null;
  effective_model: string | null;
}

export interface ShapingModelPickerOption {
  model_id: string;
  used_by_seats: ShapingModelSeat[];
  saved_preference: boolean;
  recommended: boolean;
  preselected: boolean;
  reuse_warning: string | null;
}

export class InvalidPortfolioPreferencesError extends Error {
  readonly kind = "invalid_portfolio_preferences" as const;

  constructor(
    readonly artifactPath: string,
    readonly reason: string,
  ) {
    super(`${artifactPath}: ${reason}`);
    this.name = "InvalidPortfolioPreferencesError";
  }
}

const adapterSeatModelPreferencesSchema: z.ZodType<AdapterSeatModelPreferences> =
  z
    .strictObject({
      brainstorm: exactNonEmptyStringSchema.optional(),
      spec: exactNonEmptyStringSchema.optional(),
      plan: exactNonEmptyStringSchema.optional(),
    })
    .refine(
      (preferences) => Object.values(preferences).length > 0,
      "an adapter must have at least one seat preference",
    );

export const portfolioPreferencesV1Schema: z.ZodType<PortfolioPreferencesV1> =
  z.strictObject({
    schema_version: z.literal(PORTFOLIO_PREFERENCES_SCHEMA_VERSION),
    preferences: z.record(
      exactNonEmptyStringSchema,
      adapterSeatModelPreferencesSchema,
    ),
  });

export const setSeatModelPreferenceInputSchema: z.ZodType<SetSeatModelPreferenceInput> =
  z.strictObject({
    adapter_id: exactNonEmptyStringSchema,
    seat: z.enum(SHAPING_MODEL_SEATS),
    requested_model: exactNonEmptyStringSchema,
  });

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function seatOrder(seat: ShapingModelSeat): number {
  return SHAPING_MODEL_SEATS.indexOf(seat);
}

function configuredModels(availableModelIds: readonly string[]): string[] {
  const parsed = z.array(exactNonEmptyStringSchema).parse([...availableModelIds]);
  return [...new Set(parsed)];
}

export function summarizeWorkflowModelUse(
  runs: readonly ShapingRunRecordV1[],
  productions: readonly WorkflowShapingProduction[],
): WorkflowModelUse[] {
  const runsById = new Map<string, ShapingRunRecordV1>();
  for (const run of runs) {
    if (runsById.has(run.shaping_run_id)) {
      throw new Error(`Duplicate shaping run ${run.shaping_run_id}.`);
    }
    runsById.set(run.shaping_run_id, run);
  }

  const usesBySeat = new Map<ShapingModelSeat, WorkflowModelUse>();
  for (const production of productions) {
    if (usesBySeat.has(production.seat)) {
      throw new Error(`Duplicate production for ${production.seat} seat.`);
    }

    const receipt = production.receipt;
    if (receipt.origin === "connected_run") {
      const run = runsById.get(receipt.shaping_run_id);
      if (run === undefined) {
        throw new Error(
          `Production ${receipt.production_id} references an unknown shaping run.`,
        );
      }
      if (run.mission.phase !== production.seat) {
        throw new Error(
          `Production ${receipt.production_id} does not match its shaping seat.`,
        );
      }
    }

    usesBySeat.set(production.seat, {
      seat: production.seat,
      production_id: receipt.production_id,
      shaping_run_id: receipt.shaping_run_id,
      requested_model: receipt.requested_model.value,
      effective_model:
        receipt.effective_model.assurance === "adapter_attested"
          ? receipt.effective_model.model_id
          : null,
    });
  }

  return [...usesBySeat.values()].sort(
    (left, right) => seatOrder(left.seat) - seatOrder(right.seat),
  );
}

export function recommendUnusedModel(
  availableModelIds: readonly string[],
  usedEffectiveOrRequestedIds: readonly string[],
): string | null {
  const available = configuredModels(availableModelIds);
  const used = new Set(
    z.array(exactNonEmptyStringSchema).parse([
      ...usedEffectiveOrRequestedIds,
    ]),
  );
  return available.find((modelId) => !used.has(modelId)) ?? null;
}

export function shapingModelPickerOptions(
  availableModelIds: readonly string[],
  modelUses: readonly WorkflowModelUse[],
  savedPreference: string | null,
): ShapingModelPickerOption[] {
  const available = configuredModels(availableModelIds);
  const parsedSavedPreference =
    savedPreference === null
      ? null
      : exactNonEmptyStringSchema.parse(savedPreference);
  const availableSet = new Set(available);
  const usedByModel = new Map<string, Set<ShapingModelSeat>>();

  for (const use of modelUses) {
    const usedModel = use.effective_model ?? use.requested_model;
    if (usedModel === null) {
      continue;
    }
    const seats = usedByModel.get(usedModel) ?? new Set<ShapingModelSeat>();
    seats.add(use.seat);
    usedByModel.set(usedModel, seats);
  }

  const usedIds = [...usedByModel.keys()];
  const recommendation = recommendUnusedModel(available, usedIds);
  const savedIsAvailable =
    parsedSavedPreference !== null && availableSet.has(parsedSavedPreference);
  const savedWasUsed =
    savedIsAvailable && usedByModel.has(parsedSavedPreference);
  const preselected =
    savedIsAvailable && !savedWasUsed
      ? parsedSavedPreference
      : recommendation ?? (savedIsAvailable ? parsedSavedPreference : null);
  const configuredOrder = new Map(
    available.map((modelId, index) => [modelId, index]),
  );

  return available
    .map((modelId): ShapingModelPickerOption => {
      const usedBySeats = [...(usedByModel.get(modelId) ?? [])].sort(
        (left, right) => seatOrder(left) - seatOrder(right),
      );
      return {
        model_id: modelId,
        used_by_seats: usedBySeats,
        saved_preference: modelId === parsedSavedPreference,
        recommended: modelId === recommendation,
        preselected: modelId === preselected,
        reuse_warning:
          usedBySeats.length === 0
            ? null
            : `${modelId} was already used by ${usedBySeats.join(
                ", ",
              )}; reuse is allowed, but an unused model improves seat independence.`,
      };
    })
    .sort((left, right) => {
      const usedOrder = Number(left.used_by_seats.length > 0) -
        Number(right.used_by_seats.length > 0);
      if (usedOrder !== 0) {
        return usedOrder;
      }
      return (
        (configuredOrder.get(left.model_id) ?? Number.MAX_SAFE_INTEGER) -
        (configuredOrder.get(right.model_id) ?? Number.MAX_SAFE_INTEGER)
      );
    });
}

export function canonicalPortfolioPreferences(
  input: PortfolioPreferencesV1,
): PortfolioPreferencesV1 {
  const document = portfolioPreferencesV1Schema.parse(input);
  const preferences = Object.fromEntries(
    Object.entries(document.preferences)
      .sort(([left], [right]) => compareCanonical(left, right))
      .map(([adapterId, seats]) => [
        adapterId,
        Object.fromEntries(
          SHAPING_MODEL_SEATS.flatMap((seat) =>
            seats[seat] === undefined ? [] : [[seat, seats[seat]]],
          ),
        ),
      ]),
  );
  return portfolioPreferencesV1Schema.parse({
    schema_version: PORTFOLIO_PREFERENCES_SCHEMA_VERSION,
    preferences,
  });
}
