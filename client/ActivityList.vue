<script setup lang="ts">
import { computed, ref } from 'vue'
import ConfirmationDialog from './ConfirmationDialog.vue'
import { api } from './api'
import type { ActivityItem, OperationResult } from '../shared/types'

const props = defineProps<{
  token: string
  activities: ActivityItem[]
  removed: ActivityItem[]
}>()
const emit = defineEmits<{ choose: [id: string]; refresh: [] }>()
const trash = ref(false)
const selected = ref<string[]>([])
const rows = computed(() => (trash.value ? props.removed : props.activities))
const confirmation = ref<{
  items: ActivityItem[]
  operation: string
  restore: boolean
}>()
const messages = ref<OperationResult[]>([])
const error = ref('')
const busy = ref(false)
function switchList() {
  trash.value = !trash.value
  selected.value = []
  messages.value = []
  error.value = ''
}
function review(items: ActivityItem[]) {
  if (!items.length) return
  confirmation.value = {
    items,
    operation: Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) =>
      n.toString(16).padStart(8, '0'),
    ).join(''),
    restore: trash.value,
  }
  error.value = ''
}
async function confirm() {
  const pending = confirmation.value
  if (!pending || busy.value) return
  busy.value = true
  const eligible = pending.items.filter((a) => !a.reason)
  try {
    const results = await api<OperationResult[]>(
      'teacher/' + (pending.restore ? 'restore' : 'remove'),
      props.token,
      {
        operation: pending.operation,
        items: eligible.map(({ id, version }) => ({ id, version })),
      },
    )
    messages.value = pending.items.map((a) => {
      const result = results.find((r) => r.id === a.id)
      return {
        ...result,
        id: a.id,
        message:
          a.title + '（' + a.code + '） ' + (result?.message ?? a.reason),
      }
    })
    selected.value = []
    confirmation.value = undefined
    emit('refresh')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <section class="panel">
    <div class="title-row">
      <h2>{{ trash ? '已移除' : '活動列表' }}</h2>
      <button @click="switchList" :disabled="!!confirmation">
        {{ trash ? '返回我的活動' : '已移除清單' }}
      </button>
    </div>
    <button
      v-if="!trash"
      :disabled="!selected.length || !!confirmation"
      @click="review(rows.filter((a) => selected.includes(a.id)))"
    >
      移除勾選活動
    </button>
    <p v-if="!rows.length">目前沒有活動</p>
    <div
      v-for="a in rows"
      :key="a.id"
      class="activity-row"
      :data-activity="a.id"
    >
      <input
        v-if="!trash"
        type="checkbox"
        :aria-label="'勾選 ' + a.title + ' ' + a.code"
        v-model="selected"
        :value="a.id"
      />
      <button v-if="!trash" class="activity" @click="emit('choose', a.id)">
        {{ a.title }} · {{ a.code }} · {{ a.phase }}
      </button>
      <span v-else
        >{{ a.title }} · {{ a.code }} · {{ a.phase }} · 還原期限
        {{ new Date(a.expiresAt!).toLocaleString() }}</span
      >
      <button :disabled="!!confirmation" @click="review([a])">
        {{ trash ? '還原' : '移除' }}
      </button>
    </div>
    <ConfirmationDialog
      v-if="confirmation"
      :title="confirmation.restore ? '還原活動' : '移除活動'"
      :busy="busy"
      @cancel="confirmation = undefined"
    >
      <p v-if="!confirmation.restore">
        學生將無法再進入，活動紀錄會保留。移除後十天內可還原。
      </p>
      <ul>
        <li v-for="a in confirmation.items" :key="a.id">
          {{ a.title }} · {{ a.code }} · {{ a.phase }} ·
          {{ a.reason || (confirmation.restore ? '可還原' : '可移除') }}
        </li>
      </ul>
      <button :disabled="busy" @click="confirmation = undefined">取消</button>
      <button
        class="primary"
        :disabled="busy || confirmation.items.every((a) => a.reason)"
        @click="confirm"
      >
        {{ confirmation.restore ? '確認還原' : '確認移除' }}
      </button>
      <p v-if="error" role="alert">{{ error }}</p>
    </ConfirmationDialog>
    <div role="status" v-for="result in messages" :key="result.id">
      <p>{{ result.message }}</p>
      <template v-if="result.code">
        <p>新活動碼 {{ result.code }}，請將下列組內碼分別交給對應組長。</p>
        <p v-for="g in result.groups" :key="g.label">
          {{ g.label }} · {{ g.code }}
        </p>
      </template>
    </div>
  </section>
</template>
<style scoped>
.activity-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-block: 0.6rem;
}
.activity-row .activity {
  width: auto;
  flex: 1;
  margin: 0;
}
.activity-row input {
  width: auto;
}
</style>
