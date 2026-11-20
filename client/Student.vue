<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { api, type Snapshot } from './api'
const code = ref(''),
  leader = ref(''),
  joinCode = ref(''),
  joining = ref(false)
const aid = ref(
  new URLSearchParams(location.search).get('activity') ??
    localStorage.getItem('quiz-activity') ??
    '',
)
const token = ref(localStorage.getItem('quiz-student:' + aid.value) ?? '')
const state = ref<Snapshot>(),
  drafts = ref<Record<string, string>>({}),
  error = ref(''),
  notice = ref(''),
  online = ref(false),
  busy = ref(false)
let alive = true,
  timer: ReturnType<typeof setTimeout>,
  sequence = 0
const root = () => 'activities/' + aid.value
async function refresh() {
  if (!token.value) return
  const n = ++sequence
  try {
    const v = await api<Snapshot>(root(), token.value)
    if (alive && n === sequence) {
      state.value = v
      online.value = true
    }
  } catch (e) {
    if (alive && n === sequence) {
      online.value = false
      error.value = (e as Error).message
    }
  }
}
async function poll() {
  await refresh()
  if (alive) timer = setTimeout(poll, 750)
}
function disconnected() {
  sequence++
  online.value = false
}
function reconnect() {
  online.value = false
  void refresh()
}
onMounted(() => {
  window.addEventListener('offline', disconnected)
  window.addEventListener('online', reconnect)
  void poll()
})
onUnmounted(() => {
  alive = false
  clearTimeout(timer)
  window.removeEventListener('offline', disconnected)
  window.removeEventListener('online', reconnect)
})
async function act(fn: () => Promise<void>) {
  if (busy.value) return
  error.value = ''
  notice.value = ''
  busy.value = true
  try {
    await fn()
    await refresh()
  } catch (e) {
    error.value = (e as Error).message
    await refresh()
  } finally {
    busy.value = false
  }
}
function enter() {
  return act(async () => {
    const v = await api<{ token: string; aid: string }>('enter', undefined, {
      code: code.value.trim(),
    })
    token.value = v.token
    aid.value = v.aid
    localStorage.setItem('quiz-student:' + v.aid, v.token)
    localStorage.setItem('quiz-activity', v.aid)
    history.replaceState(
      null,
      '',
      '?role=student&activity=' + encodeURIComponent(v.aid),
    )
  })
}
function group() {
  return act(async () => {
    await api(
      root() + '/group',
      token.value,
      joining.value ? { joinCode: joinCode.value } : { leader: leader.value },
    )
  })
}
function submit(q: string) {
  return act(async () => {
    const v = await api<{ status: string }>(
      root() + '/questions/' + q + '/submit',
      token.value,
      { answer: drafts.value[q] ?? '' },
    )
    notice.value = v.status
  })
}
function leave() {
  localStorage.removeItem('quiz-student:' + aid.value)
  history.replaceState(null, '', '?role=student')
  sequence++
  token.value = ''
  aid.value = ''
  state.value = undefined
  drafts.value = {}
  notice.value = ''
  error.value = ''
  localStorage.removeItem('quiz-activity')
}
</script>
<template>
  <p class="error" role="alert" v-if="error">{{ error }}</p>
  <p class="notice" role="status" v-if="notice">{{ notice }}</p>
  <section class="welcome" v-if="!token">
    <div class="intro">
      <span class="eyebrow">學生端</span>
      <h1>加入課堂搶答</h1>
      <p>輸入教師公告的活動加入碼，再建立或加入小組。</p>
    </div>
    <form class="panel entry" @submit.prevent="enter">
      <label
        >活動加入碼<input
          v-model="code"
          required
          inputmode="numeric"
          placeholder="輸入六位數代碼"
          autocomplete="off" /></label
      ><button class="primary" :disabled="busy">進入活動</button>
    </form>
  </section>
  <template v-else
    ><div class="title-row">
      <div>
        <span class="eyebrow">學生端</span>
        <h1>{{ state?.title ?? '連線中' }}</h1>
      </div>
      <button @click="leave">離開活動</button>
    </div>
    <div v-if="state && !state.group" class="panel entry">
      <h2>選擇組別</h2>
      <div class="tabs">
        <button :aria-pressed="!joining" @click="joining = false">
          組長建組</button
        ><button :aria-pressed="joining" @click="joining = true">
          加入既有組
        </button>
      </div>
      <form @submit.prevent="group">
        <label v-if="joining"
          >組內加入碼<input v-model="joinCode" required /></label
        ><label v-else>組長學號<input v-model="leader" required /></label>
        <button
          class="primary"
          :disabled="busy || (!joining && state.phase === '已結束')"
        >
          {{ joining ? '加入組別' : '建立組別' }}
        </button>
      </form>
    </div>
    <template v-if="state?.group"
      ><section class="summary">
        <div>
          <small>我的組別</small><strong>{{ state.group }}</strong>
        </div>
        <div>
          <small>活動階段</small><strong>{{ state.phase }}</strong>
        </div>
        <div v-if="state.joinCode">
          <small>組內加入碼</small><strong>{{ state.joinCode }}</strong>
        </div>
      </section>
      <div class="panel" v-if="state.phase === '準備中'">
        <h2>等待教師開場</h2>
        <p>開場後，題號與送答欄會自動顯示。</p>
      </div>
      <template v-else
        ><h2>
          課堂題目 <small>共 {{ state.questions.length }} 題</small>
        </h2>
        <div class="questions">
          <article
            v-for="q in state.questions"
            :key="q.q"
            class="panel"
            :data-q="q.q"
          >
            <div class="title-row">
              <h3>第 {{ q.label }} 題</h3>
              <span class="chip">{{
                q.ownAnswer == null ? '未作答' : '已收件'
              }}</span>
            </div>
            <div v-if="q.ownAnswer != null">
              <small>本組答案</small>
              <p class="answer">{{ q.ownAnswer }}</p>
            </div>
            <form
              v-else-if="state.phase === '開放中'"
              @submit.prevent="submit(q.q)"
            >
              <label
                >本組作答<textarea
                  v-model="drafts[q.q]"
                  rows="2"
                  :disabled="!online"
                ></textarea></label
              ><button class="primary" :disabled="busy || !online">
                送出答案
              </button>
            </form>
            <template v-if="state.phase === '已結束'"
              ><p>
                勝組 <b>{{ q.winner ?? '無有效作答／無勝組' }}</b>
              </p>
              <p v-if="q.winningAnswer !== undefined" class="answer">
                公布勝答：{{ q.winningAnswer }}
              </p></template
            >
          </article>
        </div></template
      ></template
    ></template
  >
</template>
