import type { Flow } from '@intentbridge/action-ir';

export interface CoercedVariables {
  variables: Record<string, unknown>;
  errors: string[];
}

/**
 * Coerces and validates run inputs against the flow's declared variables.
 * Unknown names are rejected so a typo cannot silently produce default-ish
 * behaviour; types are checked before the engine sees them.
 */
export function coerceFlowVariables(flow: Flow, input: Record<string, unknown>): CoercedVariables {
  const errors: string[] = [];
  const variables: Record<string, unknown> = {};
  const declared = new Map(flow.variables.map((variable) => [variable.name, variable]));
  for (const name of Object.keys(input)) {
    if (!declared.has(name)) errors.push(`unknown variable: ${name}`);
  }
  for (const variable of flow.variables) {
    const raw = input[variable.name];
    if (raw === undefined || raw === null || raw === '') {
      if (variable.required) errors.push(`missing required variable: ${variable.name}`);
      else if (variable.default !== undefined) variables[variable.name] = variable.default;
      continue;
    }
    switch (variable.type) {
      case 'number': {
        const value = typeof raw === 'number' ? raw : Number(String(raw));
        if (!Number.isFinite(value)) {
          errors.push(`variable ${variable.name} is not a number`);
          break;
        }
        variables[variable.name] = value;
        break;
      }
      case 'boolean': {
        if (typeof raw === 'boolean') variables[variable.name] = raw;
        else if (raw === 'true' || raw === 1 || raw === '1') variables[variable.name] = true;
        else if (raw === 'false' || raw === 0 || raw === '0') variables[variable.name] = false;
        else errors.push(`variable ${variable.name} is not a boolean`);
        break;
      }
      case 'date': {
        const value = String(raw);
        if (Number.isNaN(Date.parse(value))) {
          errors.push(`variable ${variable.name} is not a date`);
          break;
        }
        variables[variable.name] = value;
        break;
      }
      default: {
        const value = typeof raw === 'string' ? raw : String(raw);
        if (variable.min_length !== undefined && value.length < variable.min_length) {
          errors.push(`variable ${variable.name} is shorter than ${variable.min_length}`);
        }
        if (variable.max_length !== undefined && value.length > variable.max_length) {
          errors.push(`variable ${variable.name} is longer than ${variable.max_length}`);
        }
        if (variable.pattern) {
          try {
            if (!new RegExp(variable.pattern).test(value)) {
              errors.push(`variable ${variable.name} does not match its pattern`);
            }
          } catch {
            errors.push(`variable ${variable.name} has an invalid pattern`);
          }
        }
        variables[variable.name] = value;
      }
    }
  }
  return { variables, errors };
}
