const express = require('express')
const app = express()
const port = process.env.PORT || 5050;
const Gun = require('gun')

app.use(Gun.serve)

const server = app.listen(port, () => {
  console.log(`Gun server running on port ${port}🔥`)
})

Gun({ web: server })