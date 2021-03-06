import { validateGraphQlDocuments } from './loaders/documents/validate-documents';
import * as commander from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import * as mkdirp from 'mkdirp';
import chalk from 'chalk';
import { DocumentNode, extendSchema, GraphQLSchema, parse } from 'graphql';
import { getGraphQLProjectConfig, ConfigNotFoundError } from 'graphql-config';

import { scanForTemplatesInPath } from './loaders/template/templates-scanner';
import { ALLOWED_CUSTOM_TEMPLATE_EXT, compileTemplate } from 'graphql-codegen-compiler';
import {
  CustomProcessingFunction,
  debugLog,
  EInputType,
  FileOutput,
  GeneratorConfig,
  getLogger,
  isGeneratorConfig,
  schemaToTemplateContext,
  setSilentLogger,
  transformDocumentsFiles,
  useWinstonLogger
} from 'graphql-codegen-core';
import { CLIOptions } from './cli-options';
import { mergeGraphQLSchemas } from '@graphql-modules/epoxy';
import { makeExecutableSchema } from 'graphql-tools';
import { SchemaTemplateContext } from 'graphql-codegen-core/dist/types';
import { loadSchema, loadDocuments } from './load';
import { DetailedError } from './errors';
import spinner from './spinner';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

interface GqlGenConfig {
  flattenTypes?: boolean;
  primitives?: {
    String: string;
    Int: string;
    Float: string;
    Boolean: string;
    ID: string;
  };
  customHelpers?: { [helperName: string]: string };
  generatorConfig?: { [configName: string]: any };
}

function collect<T>(val: T, memo: T[]) {
  memo.push(val);

  return memo;
}

export const initCLI = (args: any): CLIOptions => {
  commander
    .usage('gql-gen [options]')
    .option(
      '-s, --schema <path>',
      'Path to GraphQL schema: local JSON file, GraphQL endpoint, local file that exports GraphQLSchema/AST/JSON'
    )
    .option(
      '-cs, --clientSchema <path>',
      'Path to GraphQL client schema: local JSON file, local file that exports GraphQLSchema/AST/JSON'
    )
    .option(
      '-h, --header [header]',
      'Header to add to the introspection HTTP request when using --url/--schema with url',
      collect,
      []
    )
    .option(
      '-t, --template <template-name>',
      'Language/platform name templates, or a name of NPM modules that `export default` GqlGenConfig object'
    )
    .option('-p, --project <project-path>', 'Project path(s) to scan for custom template files')
    .option('--config <json-file>', 'Codegen configuration file, defaults to: ./gql-gen.json')
    .option('-m, --skip-schema', 'Generates only client side documents, without server side schema types')
    .option('-c, --skip-documents', 'Generates only server side schema types, without client side documents')
    .option('-o, --out <path>', 'Output file(s) path', String, './')
    .option('-r, --require [require]', 'module to preload (option can be repeated)', collect, [])
    .option('-ow, --no-overwrite', 'Skip file writing if the output file(s) already exists in path')
    .option('-w, --watch', 'Watch for changes and execute generation automatically')
    .option('--silent', 'Does not print anything to the console')
    .option('-ms, --merge-schema <merge-logic>', 'Merge schemas with custom logic')
    .arguments('<options> [documents...]')
    .parse(args);

  return (commander as any) as CLIOptions;
};

export const cliError = (err: any, exitOnError = true) => {
  spinner.fail();
  let msg: string;

  if (err instanceof Error) {
    msg = err.message || err.toString();
  } else if (typeof err === 'string') {
    msg = err;
  } else {
    msg = JSON.stringify(err);
  }

  getLogger().error(msg);

  if (exitOnError) {
    process.exit(1);
  }

  return;
};

export const validateCliOptions = (options: CLIOptions) => {
  if (options.silent) {
    setSilentLogger();
  } else {
    useWinstonLogger();
  }

  const schema = options.schema;
  const template = options.template;
  const project = options.project;

  if (!schema) {
    try {
      const graphqlProjectConfig = getGraphQLProjectConfig(project);
      options.schema = graphqlProjectConfig.schemaPath;
    } catch (e) {
      if (e instanceof ConfigNotFoundError) {
        cliError(`
          
          Flag ${chalk.bold('--schema')} is missing.
          
          Schema points to one of following:
            - url of a GraphQL server
            - path to a .graphql file with GraphQL Schema
            - path to a introspection file
          

          CLI example:
            
            $ gql-gen --schema ./schema.json ...
          
          API example:
            
            generate({
              schema: './schema.json',
              ...
            });

        `);
      }
    }
  }

  if (!template && !project) {
    cliError(`
      
      Please specify the template.
      
      A template matches an npm package's name.

      CLI example:
            
        $ gql-gen --template graphql-codegen-typescript-template ...
          
      API example:
            
        generate({
          template: 'graphql-codegen-typescript-template',
          ...
        });

    `);
  }
};

export const executeWithOptions = async (options: CLIOptions & { [key: string]: any }): Promise<FileOutput[]> => {
  spinner.start('Validating options');
  validateCliOptions(options);

  const schema = options.schema;
  const clientSchema = options.clientSchema;
  const documents: string[] = options.args || [];
  let template = options.template;
  const project = options.project;
  const gqlGenConfigFilePath = options.config || './gql-gen.json';
  const out = options.out || './';
  const generateSchema: boolean = !options.skipSchema;
  const generateDocuments: boolean = !options.skipDocuments;
  const modulesToRequire: string[] = options.require || [];
  const exitOnError = typeof options.exitOnError === 'undefined' ? true : options.exitOnError;

  modulesToRequire.forEach(mod => require(mod));

  let templateConfig: GeneratorConfig | CustomProcessingFunction | null = null;

  if (template && template !== '') {
    spinner.log(`Loading template: ${template}`);
    debugLog(`[executeWithOptions] using template: ${template}`);

    // Backward compatibility for older versions
    if (
      template === 'ts' ||
      template === 'ts-single' ||
      template === 'typescript' ||
      template === 'typescript-single'
    ) {
      spinner.warn(
        `You are using the old template name, please install it from NPM and use it by it's new name: "graphql-codegen-typescript-template"`
      );
      template = 'graphql-codegen-typescript-template';
    } else if (template === 'ts-multiple' || template === 'typescript-multiple') {
      spinner.warn(
        `You are using the old template name, please install it from NPM and use it by it's new name: "graphql-codegen-typescript-template-multiple"`
      );
      template = 'graphql-codegen-typescript-template-multiple';
    }

    const localFilePath = path.resolve(process.cwd(), template);
    const localFileExists = fs.existsSync(localFilePath);

    try {
      const templateFromExport = require(localFileExists ? localFilePath : template);

      if (!templateFromExport) {
        throw new Error();
      }

      templateConfig = templateFromExport.default || templateFromExport.config || templateFromExport;
      spinner.succeed();
    } catch (e) {
      throw new DetailedError(`

        Unknown codegen template: "${template}"

        Please make sure it's installed using npm or yarn.

          $ yarn add ${template} -D

          OR

          $ npm install ${template} -D

        Template should match package's name.

      `);
    }
  }

  debugLog(`[executeWithOptions] using project: ${project}`);

  const configPath = path.resolve(process.cwd(), gqlGenConfigFilePath);
  let config: GqlGenConfig = null;

  if (fs.existsSync(configPath)) {
    getLogger().info(`Loading config file from: ${configPath}`);
    config = JSON.parse(fs.readFileSync(configPath).toString()) as GqlGenConfig;
    debugLog(`[executeWithOptions] Got project config JSON: ${JSON.stringify(config)}`);
  }

  if (project && project !== '') {
    spinner.log(`Using project: ${project}`);
    if (config === null) {
      throw new DetailedError(
        `
          To use project feature, please specify ${chalk.bold('path to the config file')} or create ${chalk.bold(
          'gql-gen.json'
        )} in your project root

          If config file is different then gql-gen.json do the following.

          CLI example:

            $ gql-gen --config ./my-gql-gen.json

          API example:

            generate({
              config: './my-gql-gen.json'
            });
        `
      );
    }

    const templates = scanForTemplatesInPath(project, ALLOWED_CUSTOM_TEMPLATE_EXT);
    const resolvedHelpers: { [key: string]: Function } = {};

    Object.keys(config.customHelpers || {}).map(helperName => {
      const filePath = config.customHelpers[helperName];
      const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);

      if (fs.existsSync(resolvedPath)) {
        const requiredFile = require(resolvedPath);

        if (requiredFile && typeof requiredFile === 'function') {
          resolvedHelpers[helperName] = requiredFile;
        } else {
          throw new DetailedError(`Custom template file ${resolvedPath} does not have a default export function.`);
        }
      } else {
        throw new DetailedError(`Custom template file ${helperName} does not exists in path: ${resolvedPath}`);
      }
    });

    templateConfig = {
      inputType: EInputType.PROJECT,
      templates,
      flattenTypes: config.flattenTypes,
      primitives: config.primitives,
      customHelpers: resolvedHelpers
    };
  }
  spinner.succeed();

  const relevantEnvVars = Object.keys(process.env)
    .filter(name => name.startsWith('CODEGEN_'))
    .reduce(
      (prev, name) => {
        const cleanName = name
          .replace('CODEGEN_', '')
          .toLowerCase()
          .replace(/[-_]+/g, ' ')
          .replace(/[^\w\s]/g, '')
          .replace(/ (.)/g, res => res.toUpperCase())
          .replace(/ /g, '');
        let value: any = process.env[name];

        if (value === 'true') {
          value = true;
        } else if (value === 'false') {
          value = false;
        }

        prev[cleanName] = value;

        return prev;
      },
      {} as GeneratorConfig['config']
    );

  let addToSchema: DocumentNode[] = [];

  if (isGeneratorConfig(templateConfig)) {
    templateConfig.config = {
      ...(config && config.generatorConfig ? config.generatorConfig || {} : {}),
      ...(options && options['templateConfig'] ? options['templateConfig'] : {}),
      ...(relevantEnvVars || {})
    };

    if (templateConfig.deprecationNote) {
      spinner.warn(`Template ${template} is deprecated: ${templateConfig.deprecationNote}`);
    }

    if (templateConfig.addToSchema) {
      const asArray = Array.isArray(templateConfig.addToSchema)
        ? templateConfig.addToSchema
        : [templateConfig.addToSchema];
      addToSchema = asArray.map(
        (extension: string | DocumentNode) => (typeof extension === 'string' ? parse(extension) : extension)
      );
    }

    if (config) {
      if ('flattenTypes' in config) {
        templateConfig.flattenTypes = config.flattenTypes;
      }

      if ('primitives' in config) {
        templateConfig.primitives = {
          ...templateConfig.primitives,
          ...config.primitives
        };
      }
    }
  }

  const executeGeneration = async () => {
    const schemas: (GraphQLSchema | Promise<GraphQLSchema>)[] = [];

    try {
      spinner.log('Loading remote schema');
      debugLog(`[executeWithOptions] Schema is being loaded `);
      schemas.push(loadSchema(schema, options));
      spinner.succeed();
    } catch (e) {
      debugLog(`[executeWithOptions] Failed to load schema`, e);
      cliError(`
      
        ${chalk.bold('Invalid schema provided.')}
        Please use a path to local file, HTTP endpoint or a glob expression.

        Local file should export a string, GraphQLSchema object or should be a .graphql file.
        GraphQL Code Generator accepts: ES6 modules and CommonJS modules.
        It should either export schema with the ${chalk.italic('schema')} variable or with default export.

        CLI example:

          $ gql-gen --schema ./path/to/schema.json ...

        API example:

          generate({
            schema: './path/to/schema.json',
            ...
          });

      `);
    }

    if (clientSchema) {
      spinner.log('Loading client schema');
      try {
        debugLog(`[executeWithOptions] Client Schema is being loaded `);
        schemas.push(loadSchema(clientSchema, options));
        spinner.succeed();
      } catch (e) {
        debugLog(`[executeWithOptions] Failed to load client schema`, e);
        cliError(`
        
          ${chalk.bold('Invalid client schema.')}
          Please use a path to local file or a glob expression.

          Local file should export a string, GraphQLSchema object or should be a .graphql file.
          GraphQL Code Generator accepts: ES6 modules and CommonJS modules.
          It should either export schema with the ${chalk.italic('schema')} variable or with default export.

          CLI example:

            $ gql-gen --clientSchema ./path/to/schema.json

          API example:

            generate({
              clientSchema: './path/to/schema.json',
              ...
            });

        `);
      }
    }

    const allSchemas = await Promise.all(schemas);

    let graphQlSchema =
      allSchemas.length === 1
        ? allSchemas[0]
        : makeExecutableSchema({ typeDefs: mergeGraphQLSchemas(allSchemas), allowUndefinedInResolve: true });

    if (addToSchema && addToSchema.length > 0) {
      for (const extension of addToSchema) {
        debugLog(`Extending GraphQL Schema with: `, extension);
        graphQlSchema = extendSchema(graphQlSchema, extension);
      }
    }

    if (process.env.VERBOSE !== undefined) {
      getLogger().info(`GraphQL Schema is: `, graphQlSchema);
    }

    const context = schemaToTemplateContext(graphQlSchema);
    debugLog(`[executeWithOptions] Schema template context build, the result is: `);
    Object.keys(context).forEach((key: keyof SchemaTemplateContext) => {
      if (Array.isArray(context[key])) {
        debugLog(`Total of ${key}: ${(context[key] as any[]).length}`);
      }
    });

    const hasDocuments = documents.length;

    if (hasDocuments) {
      spinner.log('Loading documents');
    }

    const documentsFiles = await loadDocuments(documents);
    const loadDocumentErrors = validateGraphQlDocuments(graphQlSchema, documentsFiles);

    if (loadDocumentErrors.length > 0) {
      const errors: string[] = [];
      let errorCount = 0;

      for (const loadDocumentError of loadDocumentErrors) {
        for (const graphQLError of loadDocumentError.errors) {
          errors.push(`

            ${loadDocumentError.filePath}: 
              ${graphQLError.message}

          `);
          errorCount++;
        }
      }

      cliError(
        `

          Found ${errorCount} errors.

          GraphQL Code Generator validated your GraphQL documents against the schema.
          Please fix following errors and run codegen again:


          ${errors.join('')}
        
        `,
        options.watch ? false : exitOnError
      );
    }

    const transformedDocuments = transformDocumentsFiles(graphQlSchema, documentsFiles);

    if (hasDocuments) {
      spinner.succeed();
    }

    spinner.log(`Compiling template: ${template}`);

    try {
      return compileTemplate(templateConfig, context, [transformedDocuments], {
        generateSchema,
        generateDocuments
      });
    } catch (error) {
      throw new DetailedError(`
        Failed to compile ${template} template.

        In most cases it's related to the configuration and the GraphQL schema.

          ${error.message}

      `);
    }
  };

  const normalizeOutput = (item: FileOutput) => {
    let resultName = item.filename;

    if (!path.isAbsolute(resultName)) {
      const resolved = path.resolve(process.cwd(), out);

      if (fs.existsSync(resolved)) {
        const stats = fs.lstatSync(resolved);

        if (stats.isDirectory()) {
          resultName = path.resolve(resolved, item.filename);
        } else if (stats.isFile()) {
          resultName = resolved;
        }
      } else {
        if (out.endsWith('/')) {
          resultName = path.resolve(resolved, item.filename);
        } else {
          resultName = resolved;
        }
      }
    }

    const resultDir = path.dirname(resultName);
    mkdirp.sync(resultDir);

    return {
      content: item.content,
      filename: resultName
    };
  };

  try {
    const output = await executeGeneration();

    return output.map(normalizeOutput);
  } catch (error) {
    if (error instanceof DetailedError) {
      throw error;
    } else {
      throw new DetailedError(
        `
        
        Failed to finish the task:

        ${error.message}

      `,
        error
      );
    }
  }
};
