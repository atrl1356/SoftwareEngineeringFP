<script setup lang="ts">
import { ref } from 'vue'
import Teacher from './Teacher.vue'
import Student from './Student.vue'
const role = ref(
  new URLSearchParams(location.search).get('role') === 'teacher'
    ? 'teacher'
    : 'student',
)
function select(value: string) {
  role.value = value
  history.replaceState(null, '', '?role=' + value)
}
</script>
<template>
  <header>
    <div class="header-inner">
      <a class="brand" href="./"><b class="brand-mark">Q</b>課堂搶答室</a>
      <nav aria-label="切換角色">
        <button
          :aria-current="role === 'student' ? 'page' : undefined"
          @click="select('student')"
        >
          學生端</button
        ><button
          :aria-current="role === 'teacher' ? 'page' : undefined"
          @click="select('teacher')"
        >
          教師端
        </button>
      </nav>
    </div>
  </header>
  <main><Teacher v-if="role === 'teacher'" /><Student v-else /></main>
</template>
