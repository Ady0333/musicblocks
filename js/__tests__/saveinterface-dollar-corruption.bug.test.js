// BUG: SaveInterface.prepareHTML() uses String.prototype.replace with a string
// second argument derived from user data. The JS spec interprets $&, $', $`,
// and $$ as special patterns in that argument. escapeHTML() does not escape $,
// so any user content containing $& silently corrupts the saved HTML file.
//
// Affected code: js/SaveInterface.js lines 315-319
// Root cause:    .replace(/{{ data }}/g, escapeHTML(data)) passes a string
//                replacement — $& becomes the matched placeholder text.

describe("BUG: String.prototype.replace interprets $& in user content, corrupting HTML saves", () => {
    // Exact pattern used in SaveInterface.prepareHTML() at lines 315-319.
    const buildHtml = (template, description, name, data) => {
        return template
            .replace(/{{ project_description }}/g, description)
            .replace(/{{ project_name }}/g, name)
            .replace(/{{ data }}/g, data);
    };

    // Fixed version using the function form, which never interprets $ specials.
    const buildHtmlFixed = (template, description, name, data) => {
        return template
            .replace(/{{ project_description }}/g, () => description)
            .replace(/{{ project_name }}/g, () => name)
            .replace(/{{ data }}/g, () => data);
    };

    const template =
        '<div>{{ project_description }}</div><div>{{ project_name }}</div><div class="code">{{ data }}</div>';

    test("BUG CONFIRMED: $& in data expands to matched placeholder, not the literal string", () => {
        const corruptedHtml = buildHtml(template, "desc", "My Project", '{"text":"$&"}');
        // $& is replaced with the matched text "{{ data }}", not the literal "$&"
        expect(corruptedHtml).toContain('{"text":"{{ data }}"}');
        expect(corruptedHtml).not.toContain('"$&"');
    });

    test("BUG CONFIRMED: $& in project name corrupts the name placeholder", () => {
        const corruptedHtml = buildHtml(template, "desc", "Win $& prize", "[]");
        // $& in name expands to "{{ project_name }}" — the placeholder text
        expect(corruptedHtml).toContain("Win {{ project_name }} prize");
        expect(corruptedHtml).not.toContain("Win $& prize");
    });

    test("fix: function form preserves $& literally without interpretation", () => {
        const safeHtml = buildHtmlFixed(template, "desc", "My Project", '{"text":"$&"}');
        expect(safeHtml).toContain('"$&"');
        expect(safeHtml).not.toContain('"{{ data }}"');
    });

    test("fix: function form preserves $& in project name literally", () => {
        const safeHtml = buildHtmlFixed(template, "desc", "Win $& prize", "[]");
        expect(safeHtml).toContain("Win $& prize");
        expect(safeHtml).not.toContain("Win {{ project_name }} prize");
    });
});
