const express = require('express');
const app = express();
app.get('/', (_req, res) => res.send('omnideploy smoke: express'));
app.listen(process.env.PORT || 3000);
