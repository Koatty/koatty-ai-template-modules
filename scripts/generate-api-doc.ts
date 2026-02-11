/**
 * API 文档生成脚本 - 多协议（HTTP、WebSocket、gRPC、GraphQL）
 * 基于 Typia 与 Controller/Resolver 扫描
 * 运行: npm run doc
 * 输出: docs/openapi.json (HTTP), docs/api-doc.json (全协议)
 *
 * HTTP 路由装饰器以 Koatty 官方为准：https://koatty.org/#/?id=%e8%b7%af%e7%94%b1
 * 支持 @Get / @Post / @Put / @Delete / @Patch（koatty_router）及 @GetMapping 等别名。
 *
 * 依赖: typia, ts-morph, ts-patch (用于 Typia 编译时转换)
 * 首次使用请执行: npx ts-patch install
 */
import { Project } from 'ts-morph';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const projectRoot = process.cwd();
const srcDir = path.join(projectRoot, 'src');
const scriptsDir = path.join(projectRoot, 'scripts');
const docsDir = path.join(projectRoot, 'docs');

interface DtoFileInfo {
  relImportPath: string;
  classNames: string[];
}

// --- Discovery: DTOs + 按协议分类的源文件 ---
function discoverDtosAndProtocolSources(): {
  dtos: DtoFileInfo[];
  httpControllerFiles: string[];
  allSourceFiles: string[];
} {
  const project = new Project({ compilerOptions: { strict: true } });
  project.addSourceFilesAtPaths(path.join(srcDir, '**/*.ts'));

  const dtos: DtoFileInfo[] = [];
  const httpControllerFiles: string[] = [];
  const allSourceFiles: string[] = [];

  const distDocDir = path.join(scriptsDir, 'dist-doc');
  for (const file of project.getSourceFiles()) {
    const filePath = file.getFilePath();
    allSourceFiles.push(filePath);

    if (filePath.includes('Dto.ts')) {
      const classes = file.getClasses().filter((c) => c.getName()?.endsWith('Dto'));
      if (classes.length === 0) continue;
      const relPath = path.relative(distDocDir, filePath).replace(/\.ts$/, '').replace(/\\/g, '/');
      dtos.push({ relImportPath: relPath, classNames: classes.map((c) => c.getName()!).filter(Boolean) });
    }
    if (filePath.includes('Controller.ts') || filePath.endsWith('Controller.ts')) {
      httpControllerFiles.push(filePath);
    }
  }

  return { dtos, httpControllerFiles, allSourceFiles };
}

function generateSchemaEntry(dtos: DtoFileInfo[]): string {
  const imports: string[] = [];
  const typeNames: string[] = [];

  for (const d of dtos) {
    imports.push(`import { ${d.classNames.join(', ')} } from '${d.relImportPath}';`);
    typeNames.push(...d.classNames);
  }

  const outLine = "const out = path.join(__dirname, '..', 'api-schemas.json');";
  if (typeNames.length === 0) {
    return `import * as path from 'path';
import * as fs from 'fs';
${outLine}
fs.writeFileSync(out, JSON.stringify({ version: '3.0', components: { schemas: {} }, schemas: [] }, null, 2));
`;
  }

  return [
    "import typia from 'typia';",
    "import * as path from 'path';",
    "import * as fs from 'fs';",
    '',
    ...imports,
    '',
    `const schemas = typia.json.schemas<[${typeNames.join(', ')}]>("3.0");`,
    outLine,
    'fs.writeFileSync(out, JSON.stringify(schemas, null, 2));',
  ].join('\n');
}

// --- HTTP (OpenAPI paths) ---
// 兼容 Koatty 官方路由装饰器：https://koatty.org/#/?id=%e8%b7%af%e7%94%b1
// koatty_router 使用 @Get / @Post / @Put / @Delete；部分示例使用 @GetMapping / @PostMapping
function buildHttpPaths(controllerFiles: string[]): Record<string, Record<string, unknown>> {
  const project = new Project({ compilerOptions: { strict: true } });
  const paths: Record<string, Record<string, unknown>> = {};

  for (const filePath of controllerFiles) {
    const source = project.addSourceFileAtPath(filePath);
    for (const clazz of source.getClasses()) {
      const controllerDec = clazz.getDecorator('Controller');
      const basePath = controllerDec?.getArguments()[0]?.getText().replace(/^['"]|['"]$/g, '') ?? '/';
      const base = basePath.replace(/\/$/, '') || '';

      for (const method of clazz.getMethods()) {
        const getDec = method.getDecorator('Get') ?? method.getDecorator('GetMapping');
        const postDec = method.getDecorator('Post') ?? method.getDecorator('PostMapping');
        const putDec = method.getDecorator('Put') ?? method.getDecorator('PutMapping');
        const delDec = method.getDecorator('Delete') ?? method.getDecorator('DeleteMapping');
        const patchDec = method.getDecorator('Patch') ?? method.getDecorator('PatchMapping');
        const dec = getDec ?? postDec ?? putDec ?? delDec ?? patchDec;
        if (!dec) continue;

        const methodPath = dec.getArguments()[0]?.getText().replace(/^['"]|['"]$/g, '') ?? '/';
        const fullPath = base + (methodPath === '/' ? '' : methodPath);
        const httpMethod = getDec ? 'get' : postDec ? 'post' : putDec ? 'put' : delDec ? 'delete' : 'patch';
        const summary =
          (method
            .getJsDocs()
            .map((d) => d.getDescription().trim())
            .join(' ')
            .trim() || '') || (method.getName() ?? '');

        const op: Record<string, unknown> = {
          summary: summary || `${httpMethod.toUpperCase()} ${fullPath}`,
          responses: { 200: { description: 'OK' } },
        };

        for (const p of method.getParameters()) {
          const isRequestBody = p.getDecorator('RequestBody');
          const postDec = p.getDecorator('Post'); // koatty_router: @Post() 无参表示 body
          const isBody = isRequestBody ?? (postDec && postDec.getArguments().length === 0);
          if (isBody) {
            const typeText = p.getType().getText();
            const refName = typeText.split('.').pop() ?? typeText;
            if (refName.endsWith('Dto') || refName.endsWith('DTO')) {
              op.requestBody = {
                content: {
                  'application/json': {
                    schema: { $ref: `#/components/schemas/${refName}` },
                  },
                },
              };
            }
          }
        }

        if (!paths[fullPath]) paths[fullPath] = {};
        (paths[fullPath] as Record<string, unknown>)[httpMethod] = op;
      }
    }
  }

  return paths;
}

// --- WebSocket: @WebSocket('/path') 或 @SubscribeMessage('event') ---
interface WsChannel {
  path: string;
  events: Array<{ name: string; summary: string; payloadRef?: string }>;
}

function buildWebSocketChannels(sourceFiles: string[]): WsChannel[] {
  const project = new Project({ compilerOptions: { strict: true } });
  const channelMap = new Map<string, WsChannel>();

  for (const filePath of sourceFiles) {
    const source = project.addSourceFileAtPath(filePath);
    for (const clazz of source.getClasses()) {
      for (const method of clazz.getMethods()) {
        const wsDec = method.getDecorator('WebSocket');
        const subDec = method.getDecorator('SubscribeMessage');
        const dec = wsDec ?? subDec;
        if (!dec) continue;

        const pathOrEvent = dec.getArguments()[0]?.getText().replace(/^['"]|['"]$/g, '') ?? (method.getName() ?? '');
        const summary =
          (method
            .getJsDocs()
            .map((d) => d.getDescription().trim())
            .join(' ')
            .trim() || '') || (method.getName() ?? '');
        const pathKey = wsDec ? pathOrEvent.split('/').slice(0, -1).join('/') || '/ws' : '/ws';
        const eventName = wsDec ? pathOrEvent.split('/').pop() ?? pathOrEvent : pathOrEvent;

        let ch = channelMap.get(pathKey);
        if (!ch) {
          ch = { path: pathKey, events: [] };
          channelMap.set(pathKey, ch);
        }
        ch.events.push({ name: eventName, summary, payloadRef: undefined });
      }
    }
  }

  return Array.from(channelMap.values());
}

// --- gRPC: @Grpc('/ServiceName/MethodName') ---
interface GrpcServiceMethod {
  name: string;
  fullName: string;
  summary: string;
  requestType?: string;
  responseType?: string;
}

interface GrpcService {
  name: string;
  methods: GrpcServiceMethod[];
}

function buildGrpcServices(sourceFiles: string[]): GrpcService[] {
  const project = new Project({ compilerOptions: { strict: true } });
  const serviceMap = new Map<string, GrpcService>();

  for (const filePath of sourceFiles) {
    const source = project.addSourceFileAtPath(filePath);
    for (const clazz of source.getClasses()) {
      for (const method of clazz.getMethods()) {
        const grpcDec = method.getDecorator('Grpc');
        if (!grpcDec) continue;

        const fullName = grpcDec.getArguments()[0]?.getText().replace(/^['"]|['"]$/g, '') ?? '';
        const parts = fullName.split('/').filter(Boolean);
        const serviceName = parts[0] ?? 'Unknown';
        const methodName = parts.slice(1).join('/') || (method.getName() ?? '');

        const summary =
          (method
            .getJsDocs()
            .map((d) => d.getDescription().trim())
            .join(' ')
            .trim() || '') || (method.getName() ?? '');

        const params = method.getParameters();
        const requestType = params[0]?.getType().getText();
        const returnType = method.getReturnType().getText();

        let svc = serviceMap.get(serviceName);
        if (!svc) {
          svc = { name: serviceName, methods: [] };
          serviceMap.set(serviceName, svc);
        }
        svc.methods.push({
          name: methodName,
          fullName,
          summary,
          requestType,
          responseType: returnType !== 'void' ? returnType : undefined,
        });
      }
    }
  }

  return Array.from(serviceMap.values());
}

// --- GraphQL: @Query() / @Mutation() / @Subscription() / @Resolver() ---
interface GraphQLOperation {
  name: string;
  type: 'Query' | 'Mutation' | 'Subscription';
  summary: string;
  returnType?: string;
}

interface GraphQLResolver {
  name: string;
  operations: GraphQLOperation[];
}

function buildGraphQLDoc(sourceFiles: string[]): {
  queries: GraphQLOperation[];
  mutations: GraphQLOperation[];
  subscriptions: GraphQLOperation[];
  resolvers: GraphQLResolver[];
} {
  const project = new Project({ compilerOptions: { strict: true } });
  const queries: GraphQLOperation[] = [];
  const mutations: GraphQLOperation[] = [];
  const subscriptions: GraphQLOperation[] = [];
  const resolvers: GraphQLResolver[] = [];

  for (const filePath of sourceFiles) {
    const source = project.addSourceFileAtPath(filePath);
    for (const clazz of source.getClasses()) {
      const resolverDec = clazz.getDecorator('Resolver');
      const resolverName = resolverDec?.getArguments()[0]?.getText().replace(/^['"]|['"]$/g, '') ?? clazz.getName() ?? '';
      const resolverOps: GraphQLOperation[] = [];

      for (const method of clazz.getMethods()) {
        const qDec = method.getDecorator('Query');
        const mDec = method.getDecorator('Mutation');
        const sDec = method.getDecorator('Subscription');
        const dec = qDec ?? mDec ?? sDec;
        if (!dec) continue;

        const name = dec.getArguments()[0]?.getText().replace(/^['"]|['"]$/g, '') ?? (method.getName() ?? '');
        const summary =
          (method
            .getJsDocs()
            .map((d) => d.getDescription().trim())
            .join(' ')
            .trim() || '') || (method.getName() ?? '');
        const returnType = method.getReturnType().getText();

        const op: GraphQLOperation = {
          name,
          type: qDec ? 'Query' : mDec ? 'Mutation' : 'Subscription',
          summary,
          returnType: returnType !== 'void' ? returnType : undefined,
        };

        if (qDec) queries.push(op);
        else if (mDec) mutations.push(op);
        else subscriptions.push(op);
        resolverOps.push(op);
      }

      if (resolverDec && resolverOps.length > 0) {
        resolvers.push({ name: resolverName, operations: resolverOps });
      }
    }
  }

  return { queries, mutations, subscriptions, resolvers };
}

// --- GraphQL schema 文件（.graphql）---
function findGraphQLFiles(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findGraphQLFiles(full, acc);
    else if (e.name.endsWith('.graphql')) acc.push(full);
  }
  return acc;
}

function loadGraphQLSchemaFiles(): string | undefined {
  const gqlPaths = [
    path.join(srcDir, 'schema.graphql'),
    path.join(projectRoot, 'schema.graphql'),
    path.join(srcDir, 'graphql', 'schema.graphql'),
  ];
  for (const p of gqlPaths) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf-8');
    }
  }
  const files = findGraphQLFiles(srcDir);
  if (files.length > 0) {
    return files.map((f) => fs.readFileSync(f, 'utf-8')).join('\n\n');
  }
  return undefined;
}

function main(): void {
  if (!fs.existsSync(srcDir)) {
    console.warn('No src directory found. Skip API doc generation.');
    return;
  }

  const { dtos, httpControllerFiles, allSourceFiles } = discoverDtosAndProtocolSources();

  if (!fs.existsSync(scriptsDir)) {
    fs.mkdirSync(scriptsDir, { recursive: true });
  }

  const schemaEntryPath = path.join(scriptsDir, 'schema-entry.ts');
  const schemaEntryContent = generateSchemaEntry(dtos);
  fs.writeFileSync(schemaEntryPath, schemaEntryContent);

  const tsconfigDoc = {
    compilerOptions: {
      target: 'ES2020',
      module: 'commonjs',
      outDir: path.join(scriptsDir, 'dist-doc'),
      rootDir: scriptsDir,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      declaration: false,
      plugins: [{ transform: 'typia/lib/transform' }],
    },
    include: [path.join(scriptsDir, 'schema-entry.ts')],
  };
  const tsconfigDocPath = path.join(scriptsDir, 'tsconfig.doc.json');
  fs.writeFileSync(tsconfigDocPath, JSON.stringify(tsconfigDoc, null, 2));

  let componentsSchemas: Record<string, unknown> = {};
  try {
    execSync(`npx tsc -p "${tsconfigDocPath}"`, {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    const outDir = path.join(scriptsDir, 'dist-doc');
    const schemaEntryJs = path.join(outDir, 'schema-entry.js');
    if (fs.existsSync(schemaEntryJs)) {
      execSync(`node "${schemaEntryJs}"`, { cwd: projectRoot, stdio: 'pipe' });
    }
    const apiSchemasPath = path.join(scriptsDir, 'api-schemas.json');
    if (fs.existsSync(apiSchemasPath)) {
      const raw = JSON.parse(fs.readFileSync(apiSchemasPath, 'utf-8'));
      componentsSchemas = (raw.components && raw.components.schemas) || {};
    }
  } catch (e) {
    console.warn(
      'Typia schema build failed (ensure typia and ts-patch are installed). Using empty schemas.',
      (e as Error).message
    );
  }

  const httpPaths = buildHttpPaths(httpControllerFiles);
  const websocketChannels = buildWebSocketChannels(allSourceFiles);
  const grpcServices = buildGrpcServices(allSourceFiles);
  const graphqlDoc = buildGraphQLDoc(allSourceFiles);
  const graphqlSchemaRaw = loadGraphQLSchemaFiles();

  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }

  // HTTP only: OpenAPI (向后兼容)
  const openapi = {
    openapi: '3.0.0',
    info: {
      title: 'API',
      version: '1.0.0',
      description: 'Generated from Koatty HTTP controllers and DTOs (Typia)',
    },
    paths: httpPaths,
    components: { schemas: componentsSchemas },
  };
  const openapiPath = path.join(docsDir, 'openapi.json');
  fs.writeFileSync(openapiPath, JSON.stringify(openapi, null, 2));
  console.log('HTTP (OpenAPI) written to', openapiPath);

  // 全协议统一文档
  const apiDoc = {
    version: '1.0',
    info: {
      title: 'API Documentation',
      description: 'Multi-protocol API doc (HTTP, WebSocket, gRPC, GraphQL)',
      generatedAt: new Date().toISOString(),
    },
    components: { schemas: componentsSchemas },
    protocols: {
      http: {
        description: 'REST API (OpenAPI 3.0)',
        paths: httpPaths,
      },
      websocket: {
        description: 'WebSocket channels and events (@WebSocket / @SubscribeMessage)',
        channels: websocketChannels,
      },
      grpc: {
        description: 'gRPC services (@Grpc)',
        services: grpcServices,
      },
      graphql: {
        description: 'GraphQL operations (@Query / @Mutation / @Subscription / @Resolver)',
        queries: graphqlDoc.queries,
        mutations: graphqlDoc.mutations,
        subscriptions: graphqlDoc.subscriptions,
        resolvers: graphqlDoc.resolvers,
        schema: graphqlSchemaRaw ?? undefined,
      },
    },
  };
  const apiDocPath = path.join(docsDir, 'api-doc.json');
  fs.writeFileSync(apiDocPath, JSON.stringify(apiDoc, null, 2));
  console.log('Multi-protocol doc written to', apiDocPath);
}

main();
