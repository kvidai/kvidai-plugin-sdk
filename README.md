# @kvidai/plugin-sdk

KVIDAI 플러그인을 만들기 위한 SDK. 플랫폼 소스 없이 플러그인을 만들고 테스트한다: 타입과 `definePlugin`, 테스트용 mock 플랫폼, 화면 슬롯용 React 훅, 프로젝트 생성기(`kvidai-plugin init`)가 들어 있다.

## 설치

공개 npm (누구나):

```bash
npm install --save-dev @kvidai/plugin-sdk
```

GitHub Packages (같은 이름 `@kvidai/plugin-sdk`): 공개 패키지여도 GitHub 는 설치에 토큰(`read:packages`)을 요구한다. 토큰 없이 받으려면 위의 npm 을 쓴다.

```bash
# .npmrc  (@kvidai 스코프 전체를 GitHub Packages 에서 받게 된다)
@kvidai:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

> **API 전체는 설치한 패키지 안의 문서**: `node_modules/@kvidai/plugin-sdk/docs/plugin-api.md`(서버 쪽: 라이프사이클 `register`/`bootstrap`/`destroy`, `ctx` 전체, 필터, 자기 테이블, Strapi 와의 이름 대응)와 `docs/plugin-web.md`(화면 쪽: Next.js 페이지와 슬롯).

## 새 플러그인 만들기

```bash
npx --package @kvidai/plugin-sdk kvidai-plugin init my-plugin
cd my-plugin && npm install && npm test
```

서버 코드, 테스트, `vitest.config.ts`, tsconfig 가 있는 프로젝트가 만들어진다. id 는 소문자·숫자·대시이고 영문자로 시작한다. 디렉터리가 비어 있지 않으면 아무것도 쓰지 않고 거부한다.

## 플러그인 쓰기

```ts
import { definePlugin } from '@kvidai/plugin-sdk';

export default definePlugin({
  id: 'daily-bonus',
  version: '0.1.0',
  setup(ctx) {
    ctx.routes.post('/claim', async ({ user }) => {
      const day = ctx.now().toISOString().slice(0, 10);
      // 같은 key 는 같은 사용자에게 두 번 지급되지 않는다 (더블클릭·재시도에 안전)
      return ctx.credits.grant(user!.id, { key: `day:${day}`, credits: 5 });
    });
  },
});
```

`ctx` 는 `credits`(멱등 지급), `store`(키-값), `on`(이벤트), `routes`, `config`, `log`, `now` 를 준다. 쓰는 권한은 `package.json` 의 `kvidai.permissions` 에 선언해야 한다(선언하지 않은 기능을 쓰면 `setup` 이 실패한다).

## 테스트

```ts
import { createMockCtx } from '@kvidai/plugin-sdk/testing';

const mock = createMockCtx({ manifest: pkg.kvidai, pluginId: pkg.kvidai.id });
await plugin.setup(mock.ctx);
const res = await mock.call('POST', '/claim', { userId: '1' });
mock.advance(24 * 60 * 60 * 1000); // 하루 보내기
```

mock 은 DB·서버 없이 돌고, 권한·예산·멱등성·이벤트 격리·라우트 인증을 실제 플랫폼과 같은 규칙으로 흉내 낸다. 같은 계약 시나리오(`@kvidai/plugin-sdk/contract`)를 mock 과 실제 플랫폼이 둘 다 통과한다.

## 화면 (선택)

React 컴포넌트를 정해진 자리(`dashboard.sidebar`, `dashboard.banner`, `credits.page`, `global.overlay`)에 그린다. `react`(와 테스트에는 `react-dom`)가 필요하다.

```tsx
import { definePluginUi, usePluginUi, usePluginQuery } from '@kvidai/plugin-sdk/ui';

export default definePluginUi({
  slots: { 'credits.page': MyCard },
  messages: { en: { title: 'Daily bonus' } },
});
```

컴포넌트 테스트는 `@kvidai/plugin-sdk/ui-testing` 의 `renderSlot` 을 쓴다.

## 엔트리

| import                          | 내용                                          |
| ------------------------------- | --------------------------------------------- |
| `@kvidai/plugin-sdk`            | `definePlugin`, `ctx` 타입, 슬롯·이벤트 이름  |
| `@kvidai/plugin-sdk/testing`    | `createMockCtx`                               |
| `@kvidai/plugin-sdk/contract`   | 계약 시나리오                                 |
| `@kvidai/plugin-sdk/ui`         | 화면 훅·UI 부품 타입·`definePluginUi` (React) |
| `@kvidai/plugin-sdk/ui-testing` | `renderSlot` (React, react-dom)               |
| `kvidai-plugin` (bin)           | `init <id>`                                   |

플러그인은 사내 코드 리뷰를 통과한 뒤에 설치된다. 플러그인은 플랫폼과 같은 프로세스에서 돌며 샌드박스가 아니다.

## Status

작업중(0.x). API 는 바뀔 수 있다. 라이선스: MIT.
