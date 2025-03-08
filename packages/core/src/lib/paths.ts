import { isEmpty } from 'lodash-es';
import type {
  OperationObject,
  ParameterObject,
  PathsObject,
  ResponseObject,
  ResponsesObject,
  SchemaObject,
} from 'openapi3-ts/oas31';

import { $types } from './deriver.ts';

export type Method =
  | 'get'
  | 'post'
  | 'put'
  | 'patch'
  | 'delete'
  | 'trace'
  | 'head';
export const methods = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'trace',
  'head',
] as const;
export type SemanticSource =
  | 'query'
  | 'queries'
  | 'body'
  | 'params'
  | 'headers';

const semanticSourceToOpenAPI = {
  queries: 'query',
  query: 'query',
  headers: 'header',
  params: 'path',
} as const;
export interface Selector {
  name: string;
  select: string;
  against: string;
  source: SemanticSource;
  nullable: boolean;
  required: boolean;
}

export interface ResponseItem {
  statusCode: string;
  response?: DateType;
  contentType: string;
  headers: string[];
}

export type OnOperation = (
  sourceFile: string,
  method: Method,
  path: string,
  operation: OperationObject,
) => PathsObject;
export class Paths {
  #commonZodImport?: string;
  #onOperation?: OnOperation;
  #operations: Array<{
    sourceFile: string;
    name: string;
    path: string;
    method: Method;
    selectors: Selector[];
    responses: ResponsesObject;
    tags?: string[];
    description?: string;
  }> = [];

  constructor(config: { commonZodImport?: string; onOperation?: OnOperation }) {
    this.#commonZodImport = config.commonZodImport;
    this.#onOperation = config.onOperation;
  }

  addPath(
    name: string,
    path: string,
    method: Method,
    selectors: Selector[],
    responses: ResponseItem[],
    sourceFile: string,
    tags?: string[],
    description?: string,
  ) {
    const responsesObject = this.#responseItemToResponses(responses);
    this.#operations.push({
      name,
      path,
      sourceFile,
      method,
      selectors,
      responses: responsesObject,
      tags,
      description,
    });
    return this;
  }

  #responseItemToResponses(responses: ResponseItem[]): ResponsesObject {
    const responsesObject: ResponsesObject = {};
    for (const item of responses) {
      const ct = item.contentType;
      const schema = item.response ? toSchema(item.response) : {};
      if (!responsesObject[item.statusCode]) {
        responsesObject[item.statusCode] = {
          description: `Response for ${item.statusCode}`,
          content: {
            [ct]:
              ct === 'application/octet-stream'
                ? { schema: { type: 'string', format: 'binary' } }
                : { schema },
          },
          headers: item.headers.length
            ? item.headers.reduce(
                (acc, header) => ({
                  ...acc,
                  [header]: { schema: { type: 'string' } },
                }),
                {},
              )
            : undefined,
        } satisfies ResponseObject;
      } else {
        if (!responsesObject[item.statusCode].content[ct]) {
          responsesObject[item.statusCode].content[ct] = { schema };
        } else {
          const existing = responsesObject[item.statusCode].content[ct]
            .schema as SchemaObject;
          if (existing.oneOf) {
            if (
              !existing.oneOf.find(
                (it) => JSON.stringify(it) === JSON.stringify(schema),
              )
            ) {
              existing.oneOf.push(schema);
            }
          } else if (JSON.stringify(existing) !== JSON.stringify(schema)) {
            responsesObject[item.statusCode].content[ct].schema = {
              oneOf: [existing, schema],
            };
          }
        }
      }
    }
    return responsesObject;
  }

  async #selectosToParameters(selectors: Selector[]) {
    const parameters: ParameterObject[] = [];
    const bodySchemaProps: Record<string, SchemaObject> = {};
    for (const selector of selectors) {
      if (selector.source === 'body') {
        bodySchemaProps[selector.name] = await evalZod(
          selector.against,
          this.#commonZodImport,
        );
        continue;
      }

      const parameter: ParameterObject = {
        in: semanticSourceToOpenAPI[selector.source],
        name: selector.name,
        required: selector.required,
        schema: await evalZod(selector.against, this.#commonZodImport),
      };
      parameters.push(parameter);
    }
    return { parameters, bodySchemaProps };
  }

  async getPaths() {
    const operations: PathsObject = {};
    for (const operation of this.#operations) {
      const { path, method, selectors } = operation;
      const { parameters, bodySchemaProps } =
        await this.#selectosToParameters(selectors);
      const operationObject: OperationObject = {
        operationId: operation.name,
        parameters,
        tags: operation.tags,
        description: operation.description,
        requestBody: Object.keys(bodySchemaProps).length
          ? {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: bodySchemaProps,
                  },
                },
              },
            }
          : undefined,
        responses:
          Object.keys(operation.responses).length === 0
            ? undefined
            : operation.responses,
      };
      if (!operations[path]) {
        operations[path] = {};
      }
      operations[path][method] = operationObject;
      if (this.#onOperation) {
        const operations = this.#onOperation?.(
          operation.sourceFile,
          method,
          path,
          operationObject,
        );
        Object.assign(operations, operations ?? {});
      }
    }
    return operations;
  }
}

async function evalZod(schema: string, commonZodImport?: string) {
  // https://github.com/nodejs/node/issues/51956
  const lines = [
    `import { createRequire } from "node:module";`,
    `const filename = "${import.meta.url}";`,
    `const require = createRequire(filename);`,
    `const z = require("zod");`,
    commonZodImport ? `import * as commonZod from '${commonZodImport}';` : '',
    `const {zodToJsonSchema} = require('zod-to-json-schema');`,
    `const schema = ${schema.replace('.optional()', '')};`,
    `const jsonSchema = zodToJsonSchema(schema, {
    	$refStrategy: 'root',
    	basePath: ['#', 'components', 'schemas']
    });`,
    `export default jsonSchema;`,
  ];
  const base64 = Buffer.from(lines.join('\n')).toString('base64');
  return import(`data:text/javascript;base64,${base64}`)
    .then((mod) => mod.default)
    .then(({ $schema, ...result }) => result);
}

interface DateType {
  [$types]: any[];
  kind: string;
  optional: boolean;
  value?: string;
}

export function toSchema(data: DateType | string | null | undefined): any {
  if (data === null || data === undefined) {
    return { type: 'any' };
  } else if (typeof data === 'string') {
    const isRef = data.startsWith('#');
    if (isRef) {
      return { $ref: data };
    }
    return { type: data };
  } else if (data.kind === 'literal') {
    return { enum: [data.value], type: data[$types][0] };
  } else if (data.kind === 'record') {
    return { type: 'object', additionalProperties: toSchema(data[$types][0]) };
  } else if (data.kind === 'array') {
    const items = data[$types].map(toSchema);
    return { type: 'array', items: data[$types].length ? items[0] : {} };
  } else if (data.kind === 'union') {
    return { anyOf: data[$types].map(toSchema) };
  } else if (data.kind === 'intersection') {
    return { allOf: data[$types].map(toSchema) };
  } else if ($types in data) {
    return data[$types].map(toSchema)[0] ?? {};
  } else {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      props[key] = toSchema(value as any);
    }
    return {
      type: 'object',
      properties: props,
      additionalProperties: false,
    };
  }
}

export function isHttpMethod(name: string): name is Method {
  return ['get', 'post', 'put', 'delete', 'patch'].includes(name);
}
