// HTML page routes (server-rendered EJS).

const express = require("express");

const router = express.Router();

router.get("/", (req, res) => res.redirect("/home"));
router.get("/home", (req, res) => res.render("layout", { page: "home", title: "Home" }));
router.get("/sync", (req, res) => res.render("layout", { page: "sync", title: "File Sync" }));
router.get("/admin-upload", (req, res) => res.render("layout", { page: "admin-upload", title: "Upload Interface" }));
router.get("/review", (req, res) => res.render("layout", { page: "review", title: "File Viewer" }));

module.exports = router;
