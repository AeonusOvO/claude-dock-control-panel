import { registryError } from './registry-errors';
import { assignRegistryIds } from './registry-id';
import {
  optionalRegistryArray,
  optionalRegistryBoolean,
  optionalRegistryEnum,
  optionalRegistryRecord,
  optionalRegistryString,
  requiredRegistryString,
  requireRegistryRecord,
} from './registry-parse';
import type {
  McpRegistryArgument,
  McpRegistryInputFields,
  McpRegistryKeyValueDescriptor,
  McpRegistryLocalTransport,
  McpRegistryNamedArgument,
  McpRegistryPackageAlternative,
  McpRegistryPositionalArgument,
  McpRegistryRemoteAlternative,
  McpRegistryVariableDescriptor,
} from './registry-types';

const INPUT_FORMATS = ['boolean', 'filepath', 'number', 'string'] as const;
const TRANSPORT_TYPES = ['sse', 'stdio', 'streamable-http'] as const;
const FILE_SHA256 = /^[a-f0-9]{64}$/;

const malformed = (message: string): never => {
  throw registryError('normalize', 'malformed-record', message);
};

const parseChoices = (record: Record<string, unknown>, label: string): string[] | undefined => {
  const choices = optionalRegistryArray(record, 'choices', label);
  if (choices === undefined) return undefined;
  if (choices.some((choice) => typeof choice !== 'string')) {
    return malformed(`${label}.choices must contain only strings.`);
  }
  return choices as string[];
};

const parseVariables = (
  record: Record<string, unknown>,
  label: string,
  depth: number,
): McpRegistryVariableDescriptor[] | undefined => {
  const variables = optionalRegistryRecord(record, 'variables', label);
  if (variables === undefined) return undefined;
  const parsed = Object.entries(variables).map(([name, value]) => ({
    ...parseInputFields(
      requireRegistryRecord(value, `${label}.variables.${name}`),
      `${label}.variables.${name}`,
      depth + 1,
    ),
    name,
  }));
  return assignRegistryIds('variable', parsed);
};

const parseInputFields = (
  record: Record<string, unknown>,
  label: string,
  depth = 0,
): McpRegistryInputFields => {
  if (depth > 16) return malformed(`${label} nests variables too deeply.`);
  return {
    choices: parseChoices(record, label),
    default: optionalRegistryString(record, 'default', label),
    description: optionalRegistryString(record, 'description', label),
    format: optionalRegistryEnum(record, 'format', label, INPUT_FORMATS),
    isRequired: optionalRegistryBoolean(record, 'isRequired', label),
    isSecret: optionalRegistryBoolean(record, 'isSecret', label),
    placeholder: optionalRegistryString(record, 'placeholder', label),
    value: optionalRegistryString(record, 'value', label),
    variables: parseVariables(record, label, depth),
  };
};

const parseKeyValueDescriptors = (
  values: unknown[] | undefined,
  prefix: string,
  label: string,
): McpRegistryKeyValueDescriptor[] | undefined => {
  if (values === undefined) return undefined;
  const parsed = values.map((value, index) => {
    const itemLabel = `${label}[${index}]`;
    const record = requireRegistryRecord(value, itemLabel);
    return {
      ...parseInputFields(record, itemLabel),
      name: requiredRegistryString(record, 'name', itemLabel),
    };
  });
  return assignRegistryIds(prefix, parsed);
};

const parsePositionalArgument = (
  record: Record<string, unknown>,
  label: string,
): Omit<McpRegistryPositionalArgument, 'id'> => {
  const fields = parseInputFields(record, label);
  const valueHint = optionalRegistryString(record, 'valueHint', label);
  if (fields.value === undefined && valueHint === undefined) {
    return malformed(`${label} requires value or valueHint.`);
  }
  return {
    ...fields,
    isRepeated: optionalRegistryBoolean(record, 'isRepeated', label),
    type: 'positional',
    valueHint,
  };
};

const parseNamedArgument = (
  record: Record<string, unknown>,
  label: string,
): Omit<McpRegistryNamedArgument, 'id'> => ({
  ...parseInputFields(record, label),
  isRepeated: optionalRegistryBoolean(record, 'isRepeated', label),
  name: requiredRegistryString(record, 'name', label),
  type: 'named',
});

const parseArguments = (
  values: unknown[] | undefined,
  prefix: string,
  label: string,
): McpRegistryArgument[] | undefined => {
  if (values === undefined) return undefined;
  const parsed = values.map((value, index) => {
    const itemLabel = `${label}[${index}]`;
    const record = requireRegistryRecord(value, itemLabel);
    const type = requiredRegistryString(record, 'type', itemLabel);
    if (type === 'positional') return parsePositionalArgument(record, itemLabel);
    if (type === 'named') return parseNamedArgument(record, itemLabel);
    return malformed(`${itemLabel}.type is unsupported.`);
  });
  return assignRegistryIds(prefix, parsed);
};

export const parseLocalTransport = (value: unknown, label: string): McpRegistryLocalTransport => {
  const record = requireRegistryRecord(value, label);
  const type = optionalRegistryEnum(record, 'type', label, TRANSPORT_TYPES);
  if (!type) return malformed(`${label}.type is required.`);
  if (type === 'stdio') return { type };
  return {
    headers: parseKeyValueDescriptors(
      optionalRegistryArray(record, 'headers', label),
      'header',
      `${label}.headers`,
    ),
    type,
    url: requiredRegistryString(record, 'url', label, { min: 1 }),
  };
};

export const parsePackageAlternative = (
  value: unknown,
  index: number,
): Omit<McpRegistryPackageAlternative, 'id'> => {
  const label = `server.packages[${index}]`;
  const record = requireRegistryRecord(value, label);
  return {
    environmentVariables: parseKeyValueDescriptors(
      optionalRegistryArray(record, 'environmentVariables', label),
      'environment',
      `${label}.environmentVariables`,
    ),
    fileSha256: optionalRegistryString(record, 'fileSha256', label, {
      pattern: FILE_SHA256,
    }),
    identifier: requiredRegistryString(record, 'identifier', label, { min: 1 }),
    packageArguments: parseArguments(
      optionalRegistryArray(record, 'packageArguments', label),
      'package-argument',
      `${label}.packageArguments`,
    ),
    registryBaseUrl: optionalRegistryString(record, 'registryBaseUrl', label, { min: 1 }),
    registryType: requiredRegistryString(record, 'registryType', label, { min: 1 }),
    runtimeArguments: parseArguments(
      optionalRegistryArray(record, 'runtimeArguments', label),
      'runtime-argument',
      `${label}.runtimeArguments`,
    ),
    runtimeHint: optionalRegistryString(record, 'runtimeHint', label),
    transport: parseLocalTransport(record.transport, `${label}.transport`),
    version: optionalRegistryString(record, 'version', label, { max: 255, min: 1 }),
  };
};

export const parseRemoteAlternative = (
  value: unknown,
  index: number,
): Omit<McpRegistryRemoteAlternative, 'id'> => {
  const label = `server.remotes[${index}]`;
  const record = requireRegistryRecord(value, label);
  const transport = parseLocalTransport(record, label);
  if (transport.type === 'stdio') return malformed(`${label} cannot use stdio.`);
  return {
    ...transport,
    variables: parseVariables(record, label, 0),
  };
};
