'use strict';

function notFound(req, res) {
  res.status(404).json({ error: 'Not Found' });
}

module.exports = { notFound };
