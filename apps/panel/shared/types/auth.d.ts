declare module '#auth-utils' {
  interface User {
    id: string
    email: string
    username: string
    isAdmin: boolean
  }
}

export {}
