# 플러그인 API 레퍼런스

Strapi 서버 플러그인 문서(Server API, Lifecycle functions, Configuration)의 구성을 따라 썼다. 이름도 가능한 한 Strapi 와 같다: `register` · `bootstrap` · `destroy` · `config` (`default`, `validator`). 이 문서는 플러그인의 **서버 쪽**(`server/`, Strapi 규칙)이다. 화면 쪽(`web/`, Next.js 규칙)은 `plugin-web.md`. 만드는 법과 설치 절차는 사내 가이드(`docs/plugin-development.md`), 이 문서는 "무엇이 어떤 이름으로 있는가"를 찾는 곳이다.

> **전제**: 플러그인은 core 와 같은 프로세스에서 돈다(샌드박스 없음). 모든 플러그인이 실행 중인 Strapi(`ctx.strapi`)와 DB 연결(`ctx.knex`)을 권한 없이 받는다. 정상 동작은 사람이 아니라 테스트와 CI 가 보장한다.

## 1. 한눈에 보기

```ts
import { definePlugin } from '@kvidai/plugin-sdk';

export default definePlugin({
  id: 'daily-bonus', // 바뀌지 않는다. 지급 키, 테이블 이름, 라우트 경로의 이름공간이다
  version: '0.1.0',

  // Strapi 의 `config: { default, validator }` 와 같다
  config: {
    default: { bonus: 5 },
    validator(config) {
      if (Number(config.bonus) <= 0) throw new Error('bonus must be positive');
    },
  },

  // 선택: 자기 테이블. 플러그인이 시작될 때 한 번씩만 실행된다
  migrations: [
    {
      id: '001-create-claims',
      up: (schema) =>
        schema.createTable('claims', (t) => void t.string('user_id').notNull().index()),
    },
  ],

  register(ctx) {}, // 모든 플러그인의 register 가 먼저
  bootstrap({ strapi, routes, credits, config, now, log }) {
    // 그다음 모든 플러그인의 bootstrap. Strapi 처럼 { strapi } 로 받아도 된다
    routes.post('/claim', async ({ user }) =>
      credits.grant(user!.id, {
        key: `day:${now().toISOString().slice(0, 10)}`,
        credits: Number(config.bonus),
      })
    );
  },
  destroy(ctx) {}, // Strapi 가 종료될 때
});
```

## 2. Strapi 와 이름 대응

| Strapi (서버 플러그인)             | KVIDAI                               | 비고                                                                                                                            |
| ---------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `register({ strapi })`             | `register(ctx)`                      | 모든 플러그인의 register 가 모든 bootstrap 보다 먼저. **DB 가 이미 있다**(§9 차이점)                                            |
| `bootstrap({ strapi })`            | `bootstrap(ctx)`                     | 시작할 때마다 호출되므로 여러 번 실행돼도 안전해야 한다. 이전 이름 `setup` 도 받는다                                            |
| `destroy({ strapi })`              | `destroy(ctx)`                       | 종료 시. 타이머·구독을 정리한다. 마지막에 로드된 플러그인부터                                                                   |
| `config: { default, validator }`   | `config: { default, validator }`     | 같은 모양. 값은 `ctx.config`                                                                                                    |
| `strapi` 객체                      | `ctx.strapi`                         | 같은 객체다. `ctx` 에 들어 있어서 `({ strapi })` 로 구조 분해된다                                                               |
| `strapi.db.connection` (knex)      | `ctx.knex`                           |                                                                                                                                 |
| `strapi.db.lifecycles.subscribe`   | `ctx.strapi.db.lifecycles.subscribe` | Strapi 그대로 쓴다(§7)                                                                                                          |
| `strapi.documents.use(middleware)` | `ctx.strapi.documents.use`           | Strapi 그대로 쓴다(§7)                                                                                                          |
| webhook 이벤트 `entry.create` 등   | `ctx.on(event)`                      | `ctx.on` 은 KVIDAI 가 정한 이벤트(§5). Strapi 의 `strapi.eventHub` 는 공식 문서에서 확인하지 못했으므로 쓰기 전에 직접 확인한다 |
| 콘텐츠 타입, `contentTypes`        | `migrations` + `ctx.db`              | 플러그인 전용 테이블(§6)                                                                                                        |
| routes / controllers / services    | `ctx.routes`                         | `/api/plugins/<id>/<path>` (§4)                                                                                                 |
| 설정에서 `enabled: false`          | `plugin_settings.enabled`            | 재배포 없이 끈다(§8)                                                                                                            |
| (Discourse) `register_modifier`    | `ctx.filter(name, fn)`               | 값을 바꾸는 필터(§5)                                                                                                            |

## 3. 라이프사이클

순서: **마이그레이션 → 모든 `register` → 모든 `bootstrap` → (실행) → `destroy`**. 각 함수는 동기·비동기 모두 가능하고 호스트가 끝나기를 기다린다. 한 플러그인이 던지면 그 플러그인만 로드되지 않고(로그 `[plugin:<id>] failed to load`) 나머지와 Strapi 는 그대로 시작한다.

| 함수             | 언제                      | 주의                                                                                                                                     |
| ---------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `config`         | 로드 때                   | 기본값 + 저장된 설정 + 환경변수를 합친 값에 `validator` 를 돌린다. 던지면 플러그인이 로드되지 않는다                                     |
| `migrations`     | `register` 전             | `db` 권한이 있어야 한다. 반복 실행에 안전하다. 실패하면 그 플러그인만 로드되지 않는다                                                    |
| `register(ctx)`  | 모든 플러그인에 대해 먼저 | 다른 플러그인의 `bootstrap` 이 기대하는 것을 선언한다                                                                                    |
| `bootstrap(ctx)` | register 뒤               | **서버가 시작될 때마다 호출된다.** 없는 것만 만들고 있는 것은 건드리지 않는다. Strapi 문서의 seed 예시처럼 "카테고리가 없을 때만 만든다" |
| `destroy(ctx)`   | 종료 시                   | 5초 안에 끝나지 않으면 로그만 남기고 종료를 계속한다. 던져도 종료를 막지 않는다                                                          |

플러그인이 `ctx.strapi` 로 타이머·DB 구독 같은 것을 시작했다면 `destroy` 에서 정리한다(Strapi 문서의 `clearInterval` 예시와 같다).

`destroy` 는 `strapi start`(운영, core 이미지)가 `SIGTERM`/`SIGINT` 를 받았을 때 Strapi 의 종료 처리(`strapi.destroy()`)에서 실행된다(검증함). **`strapi develop` 에서는 종료·재시작 때 실행되지 않는 것을 관찰했다**(개발 서버는 감시 프로세스 구조다). 개발 중에 정리 코드가 돌지 않아도 이상한 것이 아니다.

## 4. `ctx`

| 항목                                                          | 내용                                                                                       | 권한 선언        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------- |
| `ctx.strapi`, `ctx.knex`                                      | 실행 중인 Strapi 와 DB 연결. 제한 없음                                                     | 없음             |
| `ctx.credits.grant(userId, { key, credits, expiresInDays? })` | 멱등 지급. 같은 `key` 는 같은 사용자에게 두 번 지급되지 않는다. 일 예산·건당 한도를 지킨다 | `credits.grant`  |
| `ctx.credits.grantedKeys(userId, keys)`                       | 이미 지급된 키                                                                             | `credits.grant`  |
| `ctx.store.get/set/incr/list`                                 | 사용자별 key-value 저장소                                                                  | `store`          |
| `ctx.db.table(name)`                                          | 자기 테이블(§6)                                                                            | `db`             |
| `ctx.routes.get/post(path, handler, { auth })`                | `/api/plugins/<id>/<path>`. 기본 `auth: 'user'`                                            | `routes`         |
| `ctx.on(event, handler)`                                      | core 이벤트 구독(§5)                                                                       | `events:<event>` |
| `ctx.filter(name, fn)`                                        | 값 필터(§5)                                                                                | 없음             |
| `ctx.config`                                                  | 설정(§8)                                                                                   | 없음             |
| `ctx.log.info/error`                                          | `[plugin:<id>]` 접두어가 붙는다                                                            | 없음             |
| `ctx.now()`                                                   | 현재 시각. 테스트가 시간을 고정할 수 있도록 `new Date()` 대신 쓴다                         | 없음             |

권한은 `package.json` 의 `kvidai.permissions` 에 쓴다. **선언하지 않은 편의 API 를 쓰면 `bootstrap` 이 실패한다.** `ctx.strapi`/`ctx.knex` 로는 아무것도 막지 않으므로 권한 선언은 "무엇을 쓰는지 읽을 수 있는 목록"이자 편의 API(`ctx.credits` 의 예산·멱등)를 켜는 스위치다.

## 5. 이벤트와 필터

**이벤트 (`ctx.on`)** — core 가 자기 쓰기를 마친 _뒤에_ 알린다. 관찰만 한다(반환값 없음).

| 이벤트         | payload               | 언제             |
| -------------- | --------------------- | ---------------- |
| `user.created` | `{ userId }`          | 회원 가입        |
| `credit.used`  | `{ userId, credits }` | 크레딧을 썼을 때 |

핸들러는 다음 tick 에 돌고(core 요청을 막지 않는다), 던지거나 5초를 넘기면 로그만 남고 core 와 다른 플러그인에 영향이 없다. 꺼진 플러그인은 받지 않는다.

**필터 (`ctx.filter`)** — core 가 값을 쓰기 _전에_ 플러그인에게 넘겨 바꾸게 한다(Discourse 의 modifier).

```ts
ctx.filter('popup.list', (popups, { query }) => [...popups, { id: 'promo', ... }]);
```

| 필터         | 값                                          | 호출 위치         |
| ------------ | ------------------------------------------- | ----------------- |
| `popup.list` | 웹 앱이 보여줄 팝업 목록(API 응답의 `data`) | `GET /api/popups` |

- 설치된 순서대로 이어서 돈다. 각 필터는 앞 필터의 결과를 받는다.
- **fail-open**: 던지거나, 아무것도 반환하지 않거나(`undefined`), 2초를 넘기면 그 필터만 로그를 남기고 건너뛴다. 값은 바뀌지 않은 채 다음으로 간다. 요청이 플러그인 때문에 실패하지 않는다(Discourse 의 modifier 는 예외가 호출자로 번진다).
- 꺼진 플러그인은 호출 시점에 건너뛴다. 재배포 없이 바로 먹는다.
- 필요한 이벤트나 필터가 없으면 core 개발자에게 이름과 값의 모양을 요청한다(core 가 이름을 정하고 호출 위치를 둔다).

## 6. 자기 테이블: `migrations` 와 `ctx.db`

```ts
migrations: [
  { id: '001-create-missions', up: (schema) =>
      schema.createTable('missions', (t) => {
        t.string('user_id').notNull().index();
        t.string('title', 80).notNull();
        t.integer('reward').notNull().default(0);
        t.boolean('done').notNull().default(false);
        t.string('code').unique();
      }) },
  { id: '002-add-note', up: (schema) => schema.addColumns('missions', (t) => void t.string('note')) },
],
```

- 실제 테이블 이름은 `plugin_<id의 -를 _로>_<table>` 이다. id 는 길어도 `plugin_` + id + `_` + 테이블 이름이 64자를 넘지 않아야 한다(MySQL 한계).
- `id` 정수 기본키는 자동이다. 컬럼 타입: `string(name, length?)`, `text`, `integer`, `bigInteger`, `decimal(name, precision?, scale?)`, `boolean`, `datetime`, `json`. 수식어: `.notNull()`, `.default(v)`, `.index()`, `.unique()`.
- 마이그레이션은 앞으로만 간다. 테이블·컬럼을 지우거나 바꾸지 못한다. 한 번 배포한 마이그레이션의 `id` 와 내용은 바꾸지 않는다. 기존 테이블에 `notNull` 컬럼을 더하려면 기본값이 있어야 한다(기존 행이 값을 가져야 하므로).
- 실행 기록은 `plugin_migrations` 테이블에 남는다. 여러 인스턴스가 동시에 시작해도 안전하다.

```ts
const missions = ctx.db.table('missions');
const row = await missions.insert({ user_id: '7', title: 'Invite a friend', reward: 10 }); // id 가 붙은 행
await missions.find({ user_id: '7' }, { orderBy: ['reward', 'desc'], limit: 10, offset: 0 });
await missions.findOne({ code: 'ABC' });
await missions.update({ user_id: '7' }, { done: true }); // 바뀐 행 수
await missions.delete({ id: row.id }); // 지운 행 수
await missions.count({ done: true });
```

조건은 같은 값 비교만 한다(`null` 은 `IS NULL`). 조인·집계·트랜잭션이 필요하면 `ctx.knex` 로 직접 쓴다. 값은 선언한 타입으로 돌아온다(boolean 은 `true/false`, decimal 은 숫자, datetime 은 `Date`, json 은 객체).

플러그인을 목록에서 빼도 이 테이블과 `plugin_migrations` 행은 **자동으로 지워지지 않는다**(Strapi, Discourse 문서에서도 제거 시 데이터 처리는 확인하지 못했다). 데이터가 필요 없으면 직접 지운다.

## 7. Strapi 를 직접 쓰기 (`ctx.strapi`)

Strapi 문서의 모든 서버 API 를 쓸 수 있다. 문서가 밝힌 한계는 그대로다.

- **DB lifecycle 훅** (`ctx.strapi.db.lifecycles.subscribe`): `beforeCreate`/`afterCreate`/`beforeUpdate`/… 18개. `event.state` 로 before→after 값을 넘긴다. **knex 로 직접 쓰면 훅이 돌지 않는다**(Strapi 문서 그대로). `ctx.db`, `ctx.knex` 로 쓴 것도 마찬가지다.
- **Document Service 미들웨어** (`ctx.strapi.documents.use`): 입력을 바꾸고 `next()` 의 결과를 **반드시 반환**한다(안 하면 앱이 깨진다고 Strapi 문서가 경고한다).
- **다른 플러그인/내장 기능을 덮어쓰기**: Strapi 문서가 "Internal extension points are not part of Strapi's stable public API and can change between versions"라고 한다. 업그레이드 때 깨질 수 있으므로 가능하면 이벤트·필터·정책을 먼저 쓴다.
- 플러그인을 꺼도 `ctx.strapi` 로 등록한 훅·미들웨어·타이머는 멈추지 않는다(라우트, 이벤트, 필터만 꺼진다). 필요하면 훅 안에서 설정을 확인하거나 `destroy` 에서 정리한다.

## 8. 설정과 켜고 끄기

- `ctx.config` = `config.default` ← `plugin_settings` 행의 `config`(JSON) ← 환경변수 `KVIDAI_PLUGIN_<ID>_<KEY>`(뒤로 갈수록 우선; `ID` 의 `-` 는 `_`, 모두 대문자). 로드 때 한 번 읽으므로 바꾸면 재시작해야 한다.
- 켜고 끄기: `plugin_settings.enabled`. 꺼지면 라우트는 404, 이벤트와 필터는 건너뛴다. 재배포가 필요 없다(약 5초 캐시).
- 호환성: `kvidai.sdkVersion`(필수)이 코어가 제공하는 플러그인 API 버전을 만족해야 한다. `plugins:sync` 는 맞지 않으면 설치를 거부하고, 코어는 부팅 때 맞지 않는 플러그인만 건너뛴다(오류 로그, 나머지는 정상). 지원하는 범위 형식은 `1.2.3` `^1.2.3` `~1.2.3` `>=1.2.3` 이다.

## 9. Strapi 와 다른 점

|                 | Strapi                                  | KVIDAI                                                                                                                   |
| --------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `register` 시점 | DB·라우트 초기화 전                     | Strapi 자신의 bootstrap 안이라 DB 가 이미 있다. 순서(모든 register → 모든 bootstrap)만 같다                              |
| 콘텐츠 타입     | 플러그인이 선언                         | `migrations` 의 자기 테이블. Strapi 콘텐츠 타입이 필요하면 `ctx.strapi` 로 등록해야 하고 admin UI 는 지원하지 않는다     |
| 플러그인 배포   | 소스를 프로젝트에 넣고 빌드             | 설치 담당이 `plugins.json` + `pnpm plugins:sync`(번들이 커밋된다) 또는 개발용 `KVIDAI_PLUGIN_DIR` + `pnpm plugins:build` |
| admin 패널 확장 | 가능                                    | 지원하지 않음. 사용자 화면은 같은 플러그인의 `web/` 쪽(Next.js 슬롯과 페이지, `plugin-web.md`)                           |
| 이벤트 오류     | (리스너 순차 실행)                      | 격리 + 5초 타임아웃                                                                                                      |
| 필터            | 없음 (Document Service 미들웨어가 비슷) | fail-open, 2초 타임아웃                                                                                                  |

## 10. 테스트

```ts
import { loadMockPlugin } from '@kvidai/plugin-sdk/testing';

const mock = await loadMockPlugin(plugin, { manifest: pkg.kvidai });
await mock.call('POST', '/claim', { userId: '7' });
await mock.applyFilter('popup.list', [], { query: {} });
await mock.emit('user.created', { userId: '7' });
await mock.destroy();
```

`loadMockPlugin` 은 호스트와 같은 순서로(`config` 병합과 `validator` → `migrations` → `register` → `bootstrap`) 플러그인을 올린다. mock 에는 Strapi 가 없으므로 `ctx.strapi`/`ctx.knex` 는 직접 넘긴 fake 를 돌려준다: `loadMockPlugin(plugin, { manifest, strapi: { ... }, knex })`. 그 코드의 실제 동작은 core 이미지 위에서 확인한다.

**`ctx.strapi` 타입**: 기본은 `any` 다. Strapi 의 타입으로 자동완성을 받으려면 `@strapi/strapi` 를 devDependency 로 설치하고 파일 하나(예: `src/kvidai.d.ts`)를 더한다.

```ts
import type { Core } from '@strapi/strapi';
declare module '@kvidai/plugin-sdk' {
  interface PluginHostTypes {
    strapi: Core.Strapi;
  }
}
```

mock 과 실제 호스트는 같은 계약 시나리오(`@kvidai/plugin-sdk/contract`)를 통과한다. 둘이 어긋나면 한쪽 테스트가 깨진다.

## 11. 설치 / 제거

- 사내 설치: `plugins.json` 에 한 줄 → `pnpm plugins:sync` → 재배포. `plugins:sync` 는 막지 않고 **무엇을 쓰는지**(`process.env`, Node 내장 모듈, `eval`)를 `notes` 로 출력한다. CI 로그에서 확인한다.
- 개발용 core 이미지: `pnpm plugins:build plugins/<id> --out <dir>` 의 결과를 `KVIDAI_PLUGIN_DIR` 로 마운트한다.
- 제거: 목록에서 빼고 재배포한다. 테이블과 `plugin_migrations` 행은 남는다(§6).
