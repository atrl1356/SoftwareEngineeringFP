<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import ConfirmationDialog from './ConfirmationDialog.vue'
import ActivityList from './ActivityList.vue'
import type { ActivityItem } from '../shared/types'
import { api, ApiError, type Snapshot, type Preview } from './api'
const token = ref(localStorage.getItem('quiz-teacher') ?? ''),
  name = ref(''),
  password = ref(''),
  title = ref('')
const me = ref<{
  owner: string
  mode: string
  connected: boolean
  activities: ActivityItem[]
  removed: ActivityItem[]
}>()
const aid = ref(''),
  state = ref<Snapshot>(),
  url = ref(''),
  tab = ref<number>(),
  book = ref<{ title: string; tabs: { id: number; title: string }[] }>()
const selected = ref(''),
  question = computed(() =>
    state.value?.questions.find((q) => q.q === selected.value),
  )
const preview = ref<Preview>(),
  approved = ref<string[]>([]),
  error = ref(''),
  busy = ref(false)
let alive = true,
  timer: ReturnType<typeof setTimeout>,
  version = 0
const openConfirmation = ref('')
const root = () => 'activities/' + aid.value
async function refresh() {
  if (!token.value) return
  const v = ++version
  if (!aid.value) {
    const info = await api<NonNullable<typeof me.value>>('teacher', token.value)
    if (v === version && alive) me.value = info
  } else {
    const s = await api<Snapshot>(root(), token.value)
    if (v === version && alive) {
      state.value = s
      if (!s.questions.some((q) => q.q === selected.value))
        selected.value = s.questions[0]?.q ?? ''
    }
  }
}
async function poll() {
  try {
    await refresh()
  } catch (e) {
    error.value = (e as Error).message
  }
  if (alive) timer = setTimeout(poll, 800)
}
onMounted(poll)
onUnmounted(() => {
  alive = false
  clearTimeout(timer)
})
async function act(op: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await op()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    try {
      await refresh()
    } catch (e) {
      error.value = (e as Error).message
    }
    busy.value = false
  }
}
function login() {
  return act(async () => {
    const v = await api<{ token: string }>('login', undefined, {
      name: name.value,
      password: password.value,
    })
    token.value = v.token
    localStorage.setItem('quiz-teacher', v.token)
    password.value = ''
  })
}
async function logout() {
  try {
    await api('logout', token.value, {})
  } finally {
    version++
    localStorage.removeItem('quiz-teacher')
    token.value = ''
    me.value = undefined
    reset('')
  }
}
function reset(id: string) {
  version++
  openConfirmation.value = ''
  aid.value = id
  state.value = undefined
  selected.value = ''
  preview.value = undefined
  book.value = undefined
  error.value = ''
  url.value =
    me.value?.mode === 'fixture'
      ? 'https://docs.google.com/spreadsheets/d/classroom-fixture-v1/edit'
      : ''
}
function choose(id: string) {
  return act(async () => reset(id))
}
function create() {
  return act(async () => {
    const a = await api<{ id: string }>('activities', token.value, {
      title: title.value,
    })
    title.value = ''
    reset(a.id)
  })
}
function connect() {
  return act(async () => {
    const a = await api<{ url: string }>('google/authorize', token.value, {})
    location.assign(a.url)
  })
}
function tabs() {
  return act(async () => {
    book.value = undefined
    tab.value = undefined
    book.value = await api('books', token.value, { url: url.value })
  })
}
function command(path: string, data: Record<string, unknown> = {}) {
  return act(() =>
    api(root() + '/' + path, token.value, {
      ...data,
      version: state.value?.version,
    }),
  )
}
function openActivity(confirmation?: string) {
  return act(async () => {
    openConfirmation.value = ''
    const result = await api<{ confirmation?: string }>(
      root() + '/open',
      token.value,
      { confirmation, version: state.value?.version },
    )
    openConfirmation.value = result.confirmation ?? ''
  })
}
function selectQ(q: string) {
  selected.value = q
  preview.value = undefined
  approved.value = []
}
const qpath = () => root() + '/questions/' + selected.value + '/'
function inspect() {
  return act(async () => {
    preview.value = undefined
    approved.value = []
    preview.value = await api(qpath() + 'preview', token.value, {
      version: state.value?.version,
    })
  })
}
function write(confirm: boolean) {
  return act(async () => {
    try {
      await api(qpath() + (confirm ? 'confirm' : 'retry'), token.value, {
        version: state.value?.version,
        key: preview.value?.key,
        approved: approved.value,
      })
      preview.value = undefined
    } catch (e) {
      if (e instanceof ApiError && e.preview) {
        preview.value = e.preview
        approved.value = []
      }
      throw e
    }
  })
}
</script>
<template>
  <p v-if="error" class="error" role="alert">{{ error }}</p>
  <section v-if="!token" class="welcome">
    <div class="intro">
      <span class="eyebrow">教師端</span>
      <h1>教師登入</h1>
      <p>管理課堂活動、查看作答順位，並將結果寫回學習單。</p>
    </div>
    <form class="panel entry" @submit.prevent="login">
      <label
        >教師帳號<input
          v-model="name"
          autocomplete="username"
          required /></label
      ><label
        >密碼<input
          v-model="password"
          type="password"
          autocomplete="current-password"
          required /></label
      ><button class="primary" :disabled="busy">登入</button>
    </form>
  </section>
  <template v-else-if="!aid"
    ><div class="title-row">
      <div>
        <span class="eyebrow">教師端</span>
        <h1>我的活動</h1>
      </div>
      <button @click="logout">登出</button>
    </div>
    <section class="panel">
      <form class="inline" @submit.prevent="create">
        <label
          >活動名稱<input
            v-model="title"
            required
            placeholder="例如：計算機概論" /></label
        ><button class="primary" :disabled="busy">建立活動</button>
      </form>
      <button v-if="me?.mode === 'google'" @click="connect">
        {{ me.connected ? '重新授權 Google' : '連結 Google 帳號' }}
      </button>
    </section>
    <ActivityList
      v-if="me"
      :token="token"
      :activities="me.activities"
      :removed="me.removed"
      @choose="choose"
      @refresh="act(async () => {})"
  /></template>
  <template v-else
    ><div class="title-row">
      <div>
        <button class="back" @click="choose('')">← 我的活動</button>
        <h1>{{ state?.title }}</h1>
      </div>
      <span class="chip">{{ state?.phase }}</span>
    </div>
    <template v-if="state"
      ><section class="summary">
        <div>
          <small>活動加入碼</small><strong>{{ state.code }}</strong>
        </div>
        <div>
          <small>已加入組數</small><strong>{{ state.groups?.length }}</strong>
        </div>
        <div>
          <small>題數</small><strong>{{ state.questions.length }}</strong>
        </div>
      </section>
      <section class="panel" v-if="state.phase === '準備中'">
        <h2>匯入 Guided Notes</h2>
        <form class="inline" @submit.prevent="tabs">
          <label
            >Google 試算表網址<input
              v-model="url"
              type="url"
              required
              @input="book = undefined" /></label
          ><button :disabled="busy">讀取分頁</button>
        </form>
        <form
          v-if="book"
          class="inline"
          @submit.prevent="command('import', { url, tab })"
        >
          <label
            >{{ book.title }} · 選擇分頁<select v-model="tab" required>
              <option :value="undefined" disabled>選擇分頁</option>
              <option v-for="t in book.tabs" :value="t.id">
                {{ t.title }}
              </option>
            </select></label
          ><button :disabled="busy">匯入題目</button>
        </form>
        <p v-if="state.source">
          已匯入 {{ state.source.title }} ／ {{ state.source.tabTitle }} · 共
          {{ state.questions.length }} 題
        </p>
        <button
          v-if="state.source && !state.ready"
          @click="
            command('reselect', {
              ...state.source,
              count: state.questions.length,
            })
          "
        >
          確認使用保留版本
        </button>
        <button
          class="primary"
          :disabled="!state.ready || busy"
          @click="openActivity()"
        >
          開放搶答
        </button>
        <ConfirmationDialog
          v-if="openConfirmation"
          title="零組開場確認"
          :busy="busy"
          @cancel="openConfirmation = ''"
        >
          <p>目前尚無組別，仍要開放搶答嗎？</p>
          <button :disabled="busy" @click="openConfirmation = ''">取消</button>
          <button
            class="primary"
            :disabled="busy"
            @click="openActivity(openConfirmation)"
          >
            確認開場
          </button>
        </ConfirmationDialog>
      </section>
      <div v-if="state.phase === '開放中'" class="title-row">
        <h2>作答監看</h2>
        <button class="danger" :disabled="busy" @click="command('close')">
          結束整場
        </button>
      </div>
      <div class="workspace" v-if="state.questions.length">
        <aside class="panel">
          <h2>題目清單</h2>
          <button
            v-for="q in state.questions"
            :aria-pressed="selected === q.q"
            @click="selectQ(q.q)"
            :disabled="busy"
          >
            第 {{ q.label }} 題
            <small
              >{{ q.submissions?.length }} / {{ state.groups?.length }}</small
            >
          </button>
        </aside>
        <section class="panel" v-if="question">
          <div class="title-row">
            <h2>第 {{ question.label }} 題</h2>
            <span class="chip" v-if="state.phase === '已結束'">{{
              question.progress
            }}</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>組別</th>
                <th>順位</th>
                <th>作答</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in question.submissions">
                <td>{{ r.label }}</td>
                <td>{{ r.rank }}</td>
                <td class="answer">{{ r.answer }}</td>
              </tr>
              <tr
                v-for="g in state.groups?.filter(
                  (g) =>
                    !question?.submissions?.some((r) => r.label === g.label),
                )"
              >
                <td>{{ g.label }}</td>
                <td>—</td>
                <td>未作答</td>
              </tr>
            </tbody>
          </table>
          <template v-if="state.phase === '已結束'"
            ><p>
              勝組 <b>{{ question.winner ?? '無有效作答／無勝組' }}</b>
            </p>
            <p v-if="question.winner" class="answer">
              勝答：{{ question.winningAnswer }} ·
              {{ question.published ? '已公布' : '待確認公布' }}
            </p>
            <button v-if="question.winner" :disabled="busy" @click="inspect">
              預覽兩格
            </button>
            <button
              v-if="question.published && question.progress !== '已確認寫入'"
              :disabled="busy"
              @click="write(false)"
            >
              重試回寫
            </button>
            <div v-if="preview">
              <h3>回寫預覽</h3>
              <p>
                第 {{ question.label }} 題 · {{ preview.bookTitle }} ／
                {{ preview.tabTitle }}
              </p>
              <div class="slot" v-for="(s, i) in preview.slots">
                <b>{{ i ? '搶答勝組' : '作答' }} · {{ s.range }}</b>
                <p class="answer">
                  原值 {{ s.value ? JSON.stringify(s.value) : '（空白）' }} →
                  {{ s.expected }}
                </p>
                <label v-if="s.value && s.value.stringValue !== s.expected"
                  ><input
                    type="checkbox"
                    v-model="approved"
                    :value="s.address"
                  />
                  同意覆蓋此格</label
                >
              </div>
              <button class="primary" :disabled="busy" @click="write(true)">
                確認回寫
              </button>
            </div></template
          >
        </section>
      </div>
      <details v-if="state.groups?.length" class="panel">
        <summary>查看組長名冊</summary>
        <p v-for="g in state.groups">
          {{ g.label }} · {{ g.leader }}
          <span v-if="g.joinCode">· 新組內碼 {{ g.joinCode }}</span>
        </p>
      </details>
    </template></template
  >
</template>
