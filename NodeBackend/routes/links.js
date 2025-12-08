// UPDATE an existing link (title / category / price / note)
router.put("/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, category, price, note } = req.body;

    const link = await Link.findOne({ id });
    if (!link) {
      return res
        .status(404)
        .json({ success: false, message: "Link not found." });
    }

    if (typeof title === "string") link.title = title.trim();
    if (typeof category === "string") link.category = category.trim();
    if (typeof note === "string") link.note = note.trim();
    if (typeof price === "string") link.price = price.trim();

    await link.save();

    res.json({ success: true, link });
  } catch (err) {
    console.error("Update link failed:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to update link." });
  }
});