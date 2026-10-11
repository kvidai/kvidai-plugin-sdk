# 플러그인 web 쪽 레퍼런스 (Next.js)

플러그인의 `web/` 폴더는 사용자 화면(Next.js 앱)을 만든다. 서버 쪽(`server/`, Strapi 규칙)은 `plugin-api.md`, 이 문서는 web 쪽이고 **Next.js 규칙**을 따른다: 페이지는 app router 의 파일 이름(`page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`, `not-found.tsx`, 동적 세그먼트 `[id]`)으로 만든다. 그래서 Next.js 문서에 있는 것은 대부분 그대로 쓰고, 이 문서는 "플러그인이라서 다른 점"만 적는다.

> 서버 쪽 없이 web 쪽만 있는 플러그인도 되고, 반대도 된다. 한 플러그인의 두 쪽은 한 패키지이고 `types.ts` 를 공유한다.

## 1. 구조

```
my-plugin/
├── package.json          # name @kvidai-plugin/<id>, exports, "kvidai" 매니페스트
├── types.ts              # 서버와 web 이 공유하는 타입 (route 응답)
├── server/src/index.ts   # Strapi 쪽 (plugin-api.md)
└── web/src/
    ├── ui/index.tsx      # (선택) 슬롯: 기존 화면의 정해진 자리에 끼워 넣는 컴포넌트
    └── app/              # (선택) 페이지: Next.js app router 파일
        ├── page.tsx
        ├── layout.tsx
        └── items/[id]/page.tsx
```

`package.json` 의 `exports` 에 쓰는 만큼만 연다.

```json
"exports": {
  "./server": "./server/src/index.ts",
  "./types": "./types.ts",
  "./web/ui": "./web/src/ui/index.tsx",
  "./web/app/*": "./web/src/app/*.tsx"
}
```

패키지 이름은 `@kvidai-plugin/<id>` 여야 한다(앱이 이 이름으로 가져온다). `*.tsx` 가 패턴에 박혀 있는 것은 exports 대상은 확장자를 자동으로 찾지 않기 때문이고, 그래서 페이지 파일은 `.tsx` 만 받는다.

## 2. 페이지 (app router)

플러그인의 `web/src/app` 은 앱의 `/<locale>/plugins/<id>/` 아래에 붙는다. `web/src/app/items/[id]/page.tsx` → `/en/plugins/my-plugin/items/42`.

| 파일                                                                       | 용도                                      | 비고                                                            |
| -------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------- |
| `page.tsx`                                                                 | 라우트의 UI                               | 서버 컴포넌트면 `metadata`/`generateMetadata` 를 내보낼 수 있다 |
| `layout.tsx`                                                               | 이 폴더 아래를 감싸는 레이아웃            | 플러그인의 루트 `layout.tsx` 는 앱의 레이아웃 안에 중첩된다     |
| `loading.tsx`, `error.tsx`, `not-found.tsx`, `template.tsx`, `default.tsx` | Next.js 와 같다                           | `error.tsx` 는 클라이언트 컴포넌트여야 한다(`'use client'`)     |
| `_폴더/`                                                                   | 라우트가 아닌 폴더(공용 컴포넌트 두는 곳) | Next.js 의 private folder 와 같다                               |

- 위 이름이 아닌 파일(`card.tsx` 같은)은 라우트가 아니다. 가져다 쓰는 코드일 뿐이다.
- **아직 없는 것**: `route.ts`(라우트 핸들러), `@parallel` 병렬 라우트, 가로채는 라우트. 있으면 `plugins:sync` 가 오류로 알려 준다(조용히 무시하지 않는다).
- 페이지에서 서버 쪽 플러그인을 부르는 코드는 **클라이언트 컴포넌트**에 둔다(§4). 서버 컴포넌트에서는 사용자 데이터를 부를 수 없다.
- 켜고 끄기: 이 플러그인의 서버 쪽이 꺼지면 페이지 전체가 404 가 된다(§5). 서버 쪽이 없는 플러그인은 항상 켜져 있다.

서버 컴포넌트에서 `metadata` 를 쓰고 카드는 클라이언트 컴포넌트로 두는 구성:

```tsx
// web/src/app/_parts/card.tsx
'use client';
export { MyCard as default } from '../../ui/my-card';

// web/src/app/page.tsx  (서버 컴포넌트)
import Card from './_parts/card';
export const metadata = { title: 'My plugin' };
export default function Page() {
  return <Card />;
}
```

## 3. 슬롯 (기존 화면에 끼워 넣기)

페이지가 아니라 앱의 기존 화면 일부에 컴포넌트를 넣는다. `web/src/ui/index.tsx` 가 `definePluginUi` 를 내보낸다.

```tsx
import { definePluginUi } from '@kvidai/plugin-sdk/ui';

export default definePluginUi({
  slots: { 'credits.page': MyCard },
  messages: { en: { title: 'Daily bonus' }, ko: { title: '데일리 보너스' } },
});
```

| 슬롯                | 자리                                  |
| ------------------- | ------------------------------------- |
| `dashboard.sidebar` | 대시보드 사이드바                     |
| `dashboard.banner`  | 대시보드 상단 배너 영역               |
| `credits.page`      | 크레딧 페이지                         |
| `global.overlay`    | 모든 페이지 위(예: 모달, 토스트 성격) |

- 슬롯은 플러그인마다 자기 에러 경계와 Suspense 로 감싸진다. 한 플러그인이 던지면 그 카드만 사라지고 페이지는 그대로다.
- 슬롯 이름이 목록에 없으면 `definePluginUi` 가 로드할 때 오류로 알려 준다. 새 자리가 필요하면 앱 쪽에 한 줄을 더해야 하므로 core 개발자에게 요청한다.

## 4. 서버 쪽 플러그인 부르기

web 쪽이 서버 쪽과 이야기하는 방법은 **서버 플러그인의 라우트를 HTTP 로 부르는 것 하나**다.

```tsx
'use client';
import { usePluginApi, usePluginQuery } from '@kvidai/plugin-sdk/ui';
import type { Status, CheckInResult } from '../../types';

const query = usePluginQuery<Status>('attendance', '/status'); // 마운트 때 GET, query.refetch()
const api = usePluginApi('attendance');
const result = await api.post<CheckInResult>('/check-in'); // 2xx 가 아니면 PluginApiError(status, body)
```

- 요청은 `/api/plugins/<id>/<path>` 로 가고, 로그인한 사용자의 토큰은 앱이 붙인다. 플러그인은 토큰을 모른다.
- 응답 타입은 `types.ts` 를 서버와 web 이 같이 import 한다: 한쪽이 바뀌고 다른 쪽이 따라가지 않으면 빌드가 실패한다.
- 서버 → web 푸시는 없다. 다시 조회(`refetch`)하거나 주기적으로 조회한다. web ↔ web 직접 통신도 없다.
- **서버 컴포넌트에서는 사용자 데이터를 부를 수 없다**: 사용자 토큰이 브라우저에만 있다. 사용자 데이터가 필요한 UI 는 클라이언트 컴포넌트로 만든다.

## 5. 켜고 끄기

한 플러그인은 서버 쪽 상태가 켜짐(`plugin_settings.enabled`)일 때만 web 쪽도 보인다. 슬롯은 숨겨지고 페이지는 404 가 된다. 재배포는 필요 없고, 페이지는 요청마다 확인한다. 서버 쪽이 없는 플러그인은 항상 켜져 있다(빌드 때 `plugins.json` 에서 뺄 수는 있다).

## 6. UI 부품, 언어, 문구

- **부품**은 `usePluginUi()` 로 받는다: `Button`(variant `default|outline|ghost`, size `default|sm`), `Card`, `CardHeader`, `CardTitle`, `CardContent`, `Badge`. 앱의 컴포넌트나 디자인 토큰을 직접 import 하지 않는다. 앱이 같은 부품을 주입하므로 모양이 앱과 어긋나지 않는다. 필요한 부품이 없으면 core 개발자에게 요청한다.
- **언어**: `usePluginLocale()`. **문구**는 플러그인이 `messages`(`en` 필수, 없는 언어는 `en` 으로 대체)로 제공하고 `usePluginT(messages)` 로 쓴다. 앱의 번역 파일을 쓰지 않는다. `{name}` 자리표시자를 지원한다.
- 스타일은 부품의 props 나 인라인 스타일을 쓴다. 앱의 Tailwind 는 플러그인 패키지를 스캔하지 않아서 플러그인에 쓴 `className` 의 유틸리티 클래스는 만들어지지 않을 수 있다.
- React 는 선택적 peer 의존성이다. web 쪽이 있는 플러그인만 `react` 를 peerDependencies 에 두고 devDependencies 에도 넣는다(앱과 같은 버전이어야 React 가 둘로 갈라지지 않는다).

## 7. 테스트

```tsx
import { renderSlot } from '@kvidai/plugin-sdk/ui-testing';

const html = renderSlot(MyCardView, { props: { status }, locale: 'ko' }); // 정적 HTML
```

- 보이는 모양은 순수한 뷰(데이터를 props 로 받는 컴포넌트)로 나누고, 데이터를 가져오는 얇은 컨테이너만 따로 둔다. 뷰는 `renderSlot` 으로 상태별로 테스트된다.
- `renderSlot` 은 effect 를 실행하지 않는다. 상호작용(클릭, 요청)은 브라우저에서 확인한다.
- 페이지(`app/`)는 Next.js 가 렌더하므로 단위 테스트보다 실제 앱에서 확인한다.

## 8. 설치

`pnpm plugins:sync` 하나가 서버 쪽은 Strapi 로, web 쪽은 web-service 로 내보낸다(생성 파일은 손으로 고치지 않는다). web-service 쪽 결과: 슬롯 목록, 컴파일할 패키지 목록, `/[locale]/plugins/<id>/` 아래 페이지와 켜짐 확인 레이아웃, 의존성 한 줄. 서버 쪽을 먼저 배포하고 web 을 나중에 배포한다(web 이 아직 없는 서버 라우트를 부르지 않도록).
