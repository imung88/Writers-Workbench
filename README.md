# Writer's Workbench
A simple character card and lorebook builder for SillyTavern and other AI roleplay platforms. 

Credits: Inspired by The Character Foundry by u/Due_Opportunity8693, Reddit link: https://www.reddit.com/r/SillyTavernAI/s/X4QE1rYhMT.
Vibe coded with Claude. 

# Features!

You can create multiple entries and export them as entire lore books for your convenience.

You get to see the markdown output so you know exactly what the AI would see and copy it without having to download anything.

Its a HTML file so you can use it offline. No shady extensions that steals your API keys this time.

It comes with token counter, but don't expect it to be accurate.

A map maker that generates a dynamic description

Character relationship graph 

Optional Feature: MCP to connect the builder with your AI agents, see MCP folder. Optional to setup.

# Current templates available:

Main characters: full cards with contradiction, descriptions, likes/fears, NSFW sections, non-human mode

Side characters: trimmed version of the main character template, it will help you create memorable NPCs

Scenario: setting, tech level, mood, what's normal here

Locations: for any scale, from a room to a district

Items

Factions

History: events, and how they affect the present

Concepts: magic systems, laws, customs, species, anything else

# Changelog (September 17th, 2026)

- Multiple projects with separate autosaves and project backups.

- Local character imports for JSON, PNG, text, and Markdown, without requiring the template.

- Location map builder with walls, doors, objects, exits, and generated descriptions.

- Nested location groups for floors, houses, neighborhoods, and towns.

- Character relationship graph with labeled, reciprocal or one-way connections.

- Per-entry lorebook settings covering activation, keywords, placement, timing, recursion, and inclusion groups.

- Project-wide search with category filters and clickable results.

# Quality-of-life improvements

- Combined “Export everything” lorebook export.
  
- Move imported passages into template fields while preserving the original card.
  
- Two-click room and group connections without extra confirmation.
  
- Multi-selection, group movement, collapse/expand, and resizing-aware graph dragging.
  
- Keyboard shortcuts and matching dark-theme styling for search.
  
- Recovery of the previous autosaved workspace into a project.

- Removed external font requests; import processing stays local without AI.

# Changelog (September 18th, 2026)

**Paper theme**

- Added a light "paper" theme alongside the existing dark one — an easy-on-the-eyes look for long writing sessions.
- Toggle it with the **Paper** button in the top-right corner of the header. Click again to switch back to dark.
- Your choice is remembered, so the app opens in whichever theme you last used.

**MCP bridge (optional, for advanced users)**

- Added an optional plugin in the `mcp/` folder that lets an AI assistant read and edit your projects while you have the app open — so you can ask an AI to add a character, fill in fields, or build a lorebook for you.
- The AI writes real changes into the live app, and the form updates in front of you. A small status pill in the header shows whether the bridge is connected.
- **Entirely optional.** Writer's Workbench still works exactly as before without it, and nothing in that folder runs unless you deliberately start it. The HTML file stays offline and single.
- See `mcp/MCP_README.md` for setup.
