<script setup lang="ts">
import { onMounted, ref } from 'vue'
defineProps<{ title: string; busy: boolean }>()
const emit = defineEmits<{ cancel: [] }>()
const dialog = ref<HTMLDialogElement>()
onMounted(() => dialog.value?.showModal())
</script>
<template>
  <dialog
    ref="dialog"
    :aria-label="title"
    @cancel.prevent="!busy && emit('cancel')"
  >
    <h3>{{ title }}</h3>
    <slot />
  </dialog>
</template>
<style scoped>
dialog {
  max-width: min(36rem, 90vw);
  color: inherit;
  border: 1px solid #c3cec7;
  border-radius: 12px;
  padding: 1.5rem;
}
dialog::backdrop {
  background: rgb(21 40 34 / 42%);
}
</style>
