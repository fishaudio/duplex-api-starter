"""McDonald's Drive-Thru Menu, Live Order State, and Gemini Tool Definitions.

To adapt this starter to your own domain (hotel front desk, clinic scheduling, retail support),
replace this single file and update `backend/prompts.py`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from google.genai import types

TAX_RATE = 0.0825

MENU_CATALOG: list[dict[str, Any]] = [
    # Lunch & Dinner Entrees
    {"id": "big_mac", "name": "Big Mac", "category": "Burgers", "daypart": "regular", "price": 5.99, "meal_add": 3.50},
    {"id": "qpc", "name": "Quarter Pounder with Cheese", "category": "Burgers", "daypart": "regular", "price": 6.39, "meal_add": 3.50},
    {"id": "double_qpc", "name": "Double Quarter Pounder with Cheese", "category": "Burgers", "daypart": "regular", "price": 7.89, "meal_add": 3.50},
    {"id": "mcdouble", "name": "McDouble", "category": "Burgers", "daypart": "regular", "price": 3.19, "meal_add": 3.20},
    {"id": "cheeseburger", "name": "Cheeseburger", "category": "Burgers", "daypart": "regular", "price": 2.49, "meal_add": 3.20},
    {"id": "mcchicken", "name": "McChicken", "category": "Chicken & Fish", "daypart": "regular", "price": 3.19, "meal_add": 3.20},
    {"id": "mccrispy", "name": "McCrispy", "category": "Chicken & Fish", "daypart": "regular", "price": 5.69, "meal_add": 3.50},
    {"id": "spicy_mccrispy", "name": "Spicy McCrispy", "category": "Chicken & Fish", "daypart": "regular", "price": 5.89, "meal_add": 3.50},
    {"id": "filet_o_fish", "name": "Filet-O-Fish", "category": "Chicken & Fish", "daypart": "regular", "price": 5.49, "meal_add": 3.50},
    {"id": "mcnuggets_6", "name": "6 Piece Chicken McNuggets", "category": "Chicken & Fish", "daypart": "regular", "price": 3.99, "meal_add": 3.20},
    {"id": "mcnuggets_10", "name": "10 Piece Chicken McNuggets", "category": "Chicken & Fish", "daypart": "regular", "price": 5.79, "meal_add": 3.50},
    {"id": "mcnuggets_20", "name": "20 Piece Chicken McNuggets", "category": "Chicken & Fish", "daypart": "regular", "price": 8.99, "meal_add": 0.0},
    # Breakfast Entrees
    {"id": "egg_mcmuffin", "name": "Egg McMuffin", "category": "Breakfast", "daypart": "breakfast", "price": 4.79, "meal_add": 2.80},
    {"id": "sausage_mcmuffin_egg", "name": "Sausage McMuffin with Egg", "category": "Breakfast", "daypart": "breakfast", "price": 4.99, "meal_add": 2.80},
    {"id": "bacon_egg_cheese_biscuit", "name": "Bacon, Egg & Cheese Biscuit", "category": "Breakfast", "daypart": "breakfast", "price": 4.89, "meal_add": 2.80},
    {"id": "sausage_mcgriddles", "name": "Sausage, Egg & Cheese McGriddles", "category": "Breakfast", "daypart": "breakfast", "price": 5.29, "meal_add": 2.80},
    {"id": "hotcakes", "name": "Hotcakes", "category": "Breakfast", "daypart": "breakfast", "price": 4.39, "meal_add": 0.0},
    {"id": "hash_browns", "name": "Hash Browns", "category": "Sides", "daypart": "breakfast", "price": 2.39, "meal_add": 0.0},
    # Sides & Sweets
    {"id": "fries", "name": "French Fries", "category": "Sides", "daypart": "regular", "price": 3.29, "sizes": {"small": 2.49, "medium": 3.29, "large": 3.99}},
    {"id": "oreo_mcflurry", "name": "Oreo McFlurry", "category": "Sweets", "daypart": "all", "price": 4.39},
    {"id": "apple_pie", "name": "Baked Apple Pie", "category": "Sweets", "daypart": "all", "price": 1.89},
    {"id": "vanilla_shake", "name": "Vanilla Shake", "category": "Sweets", "daypart": "all", "price": 3.99, "sizes": {"small": 3.49, "medium": 3.99, "large": 4.49}},
    {"id": "chocolate_shake", "name": "Chocolate Shake", "category": "Sweets", "daypart": "all", "price": 3.99, "sizes": {"small": 3.49, "medium": 3.99, "large": 4.49}},
    # Drinks (all day)
    {"id": "coke", "name": "Coca-Cola", "category": "Drinks", "daypart": "all", "price": 1.79, "sizes": {"small": 1.49, "medium": 1.79, "large": 2.19}},
    {"id": "diet_coke", "name": "Diet Coke", "category": "Drinks", "daypart": "all", "price": 1.79, "sizes": {"small": 1.49, "medium": 1.79, "large": 2.19}},
    {"id": "sprite", "name": "Sprite", "category": "Drinks", "daypart": "all", "price": 1.79, "sizes": {"small": 1.49, "medium": 1.79, "large": 2.19}},
    {"id": "dr_pepper", "name": "Dr Pepper", "category": "Drinks", "daypart": "all", "price": 1.79, "sizes": {"small": 1.49, "medium": 1.79, "large": 2.19}},
    {"id": "coffee", "name": "Premium Roast Coffee", "category": "Drinks", "daypart": "all", "price": 1.99, "sizes": {"small": 1.59, "medium": 1.99, "large": 2.39}},
    {"id": "iced_coffee", "name": "Iced Coffee", "category": "Drinks", "daypart": "all", "price": 2.69, "sizes": {"small": 2.29, "medium": 2.69, "large": 3.09}},
    {"id": "orange_juice", "name": "Orange Juice", "category": "Drinks", "daypart": "all", "price": 2.89},
]

SAY_PROP = types.Schema(
    type=types.Type.STRING,
    description=(
        "Optional short natural phrase (3 to 7 words) spoken immediately while this tool executes "
        "so the guest is not left in silence, e.g. 'Got it, adding that now.' Leave empty if you already spoke."
    ),
)


def get_gemini_tools() -> types.Tool:
    """Return Gemini function declarations for the Drive-Thru POS."""
    return types.Tool(
        function_declarations=[
            types.FunctionDeclaration(
                name="add_item",
                description="Add an item to the guest's order.",
                parameters=types.Schema(
                    type=types.Type.OBJECT,
                    properties={
                        "item": types.Schema(type=types.Type.STRING, description="Menu item name, e.g. 'Big Mac', '10 Piece McNuggets', 'Coca-Cola'"),
                        "qty": types.Schema(type=types.Type.INTEGER, description="Quantity (default 1)"),
                        "size": types.Schema(type=types.Type.STRING, description="small, medium, or large"),
                        "meal": types.Schema(type=types.Type.BOOLEAN, description="True to make it a combo meal with side and drink"),
                        "drink": types.Schema(type=types.Type.STRING, description="Drink choice when meal=True, e.g. 'Coke', 'Sprite'"),
                        "modifiers": types.Schema(
                            type=types.Type.ARRAY,
                            items=types.Schema(type=types.Type.STRING),
                            description="Customizations such as 'no pickles', 'extra cheese', 'no ice'",
                        ),
                        "say": SAY_PROP,
                    },
                    required=["item"],
                ),
            ),
            types.FunctionDeclaration(
                name="update_item",
                description="Update an existing order line by line number (quantity, size, meal, drink, or modifiers).",
                parameters=types.Schema(
                    type=types.Type.OBJECT,
                    properties={
                        "line": types.Schema(type=types.Type.INTEGER, description="1-based line number on the order board"),
                        "qty": types.Schema(type=types.Type.INTEGER),
                        "size": types.Schema(type=types.Type.STRING),
                        "meal": types.Schema(type=types.Type.BOOLEAN),
                        "drink": types.Schema(type=types.Type.STRING),
                        "modifiers": types.Schema(type=types.Type.ARRAY, items=types.Schema(type=types.Type.STRING)),
                        "say": SAY_PROP,
                    },
                    required=["line"],
                ),
            ),
            types.FunctionDeclaration(
                name="remove_item",
                description="Remove a line from the guest's order.",
                parameters=types.Schema(
                    type=types.Type.OBJECT,
                    properties={
                        "line": types.Schema(type=types.Type.INTEGER, description="1-based line number to remove"),
                        "say": SAY_PROP,
                    },
                    required=["line"],
                ),
            ),
            types.FunctionDeclaration(
                name="get_order",
                description="Retrieve all current order lines, subtotal, tax, and total before reading back the order.",
                parameters=types.Schema(
                    type=types.Type.OBJECT,
                    properties={"say": SAY_PROP},
                ),
            ),
            types.FunctionDeclaration(
                name="lookup_menu",
                description="Search available menu items and prices for the active daypart.",
                parameters=types.Schema(
                    type=types.Type.OBJECT,
                    properties={
                        "query": types.Schema(type=types.Type.STRING, description="Category or keyword to search, or empty for full menu"),
                        "say": SAY_PROP,
                    },
                ),
            ),
            types.FunctionDeclaration(
                name="confirm_order",
                description="Finalize and confirm the order once the guest approves the read-back.",
                parameters=types.Schema(
                    type=types.Type.OBJECT,
                    properties={"say": SAY_PROP},
                ),
            ),
            types.FunctionDeclaration(
                name="cancel_order",
                description="Clear all items from the order if the guest cancels.",
                parameters=types.Schema(
                    type=types.Type.OBJECT,
                    properties={"say": SAY_PROP},
                ),
            ),
        ]
    )


def _match_menu_item(query: str) -> dict[str, Any] | None:
    q = query.strip().lower()
    aliases = {
        "coke": "coke",
        "coca cola": "coke",
        "fries": "fries",
        "french fries": "fries",
        "nuggets": "mcnuggets_10",
        "mcnuggets": "mcnuggets_10",
        "6 piece": "mcnuggets_6",
        "6 pc": "mcnuggets_6",
        "10 piece": "mcnuggets_10",
        "10 pc": "mcnuggets_10",
        "20 piece": "mcnuggets_20",
        "quarter pounder": "qpc",
        "double quarter pounder": "double_qpc",
        "mcflurry": "oreo_mcflurry",
        "mcgriddle": "sausage_mcgriddles",
        "sausage mcgriddle": "sausage_mcgriddles",
    }
    if q in aliases:
        target_id = aliases[q]
        return next((m for m in MENU_CATALOG if m["id"] == target_id), None)

    for m in MENU_CATALOG:
        if q == m["name"].lower() or q == m["id"]:
            return m
    for m in MENU_CATALOG:
        if q in m["name"].lower() or m["name"].lower() in q:
            return m
    return None


@dataclass
class OrderLine:
    line: int
    item_id: str
    name: str
    qty: int = 1
    size: str = "medium"
    meal: bool = False
    drink: str = ""
    modifiers: list[str] = field(default_factory=list)
    unit_price: float = 0.0

    @property
    def line_total(self) -> float:
        return round(self.unit_price * self.qty, 2)

    def to_dict(self) -> dict[str, Any]:
        return {
            "line": self.line,
            "item_id": self.item_id,
            "name": self.name,
            "qty": self.qty,
            "size": self.size,
            "meal": self.meal,
            "drink": self.drink,
            "modifiers": list(self.modifiers),
            "unit_price": round(self.unit_price, 2),
            "line_total": self.line_total,
        }


@dataclass
class DriveThruOrderState:
    daypart: str = "regular"  # "regular" or "breakfast"
    status: str = "open"      # "open" | "confirmed" | "cancelled"
    order_number: int = 142
    lines: list[OrderLine] = field(default_factory=list)

    def reset(self) -> None:
        self.lines.clear()
        self.status = "open"
        self.order_number += 1

    def _compute_unit_price(self, menu_entry: dict[str, Any], size: str, meal: bool) -> float:
        sz = (size or "medium").lower()
        sizes = menu_entry.get("sizes")
        base = float(sizes.get(sz, menu_entry["price"])) if isinstance(sizes, dict) else float(menu_entry["price"])
        if meal and menu_entry.get("meal_add", 0.0) > 0:
            base += float(menu_entry["meal_add"])
            if sz == "large":
                base += 1.00
        for mod in []:
            _ = mod
        return round(base, 2)

    def snapshot(self) -> dict[str, Any]:
        subtotal = round(sum(l.line_total for l in self.lines), 2)
        tax = round(subtotal * TAX_RATE, 2)
        total = round(subtotal + tax, 2)
        return {
            "daypart": self.daypart,
            "status": self.status,
            "order_number": self.order_number,
            "lines": [l.to_dict() for l in self.lines],
            "subtotal": subtotal,
            "tax": tax,
            "total": total,
        }

    def execute_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if name == "lookup_menu":
            q = str(args.get("query", "")).strip().lower()
            avail = [
                {
                    "name": m["name"],
                    "category": m["category"],
                    "price": m["price"],
                    "meal_available": bool(m.get("meal_add", 0) > 0),
                }
                for m in MENU_CATALOG
                if m["daypart"] in ("all", self.daypart)
                and (not q or q in m["name"].lower() or q in m["category"].lower())
            ]
            return {"daypart": self.daypart, "items": avail}

        if name == "add_item":
            raw_item = str(args.get("item", ""))
            entry = _match_menu_item(raw_item)
            if entry is None:
                return {"ok": False, "error": f"Unknown menu item: {raw_item!r}. Use lookup_menu to check available items."}
            if entry["daypart"] not in ("all", self.daypart):
                return {
                    "ok": False,
                    "error": f"{entry['name']} is only served during {entry['daypart']}. Active menu is {self.daypart}.",
                }
            qty = max(1, int(args.get("qty") or 1))
            size = str(args.get("size") or "medium").lower()
            meal = bool(args.get("meal", False)) and bool(entry.get("meal_add", 0) > 0)
            drink = str(args.get("drink") or ("Coca-Cola" if meal else ""))
            mods = [str(x) for x in (args.get("modifiers") or []) if str(x).strip()]
            unit_price = self._compute_unit_price(entry, size, meal)

            line_obj = OrderLine(
                line=len(self.lines) + 1,
                item_id=entry["id"],
                name=entry["name"],
                qty=qty,
                size=size,
                meal=meal,
                drink=drink,
                modifiers=mods,
                unit_price=unit_price,
            )
            self.lines.append(line_obj)
            self.status = "open"
            need_drink = meal and not args.get("drink")
            return {
                "ok": True,
                "added": line_obj.to_dict(),
                "ask_for_drink": need_drink,
                "order": self.snapshot(),
            }

        if name == "update_item":
            idx = int(args.get("line", 0)) - 1
            if idx < 0 or idx >= len(self.lines):
                return {"ok": False, "error": f"Line {idx + 1} does not exist."}
            target = self.lines[idx]
            entry = next((m for m in MENU_CATALOG if m["id"] == target.item_id), MENU_CATALOG[0])
            if "qty" in args and args["qty"] is not None:
                target.qty = max(1, int(args["qty"]))
            if "size" in args and args["size"]:
                target.size = str(args["size"]).lower()
            if "meal" in args and args["meal"] is not None:
                target.meal = bool(args["meal"]) and bool(entry.get("meal_add", 0) > 0)
            if "drink" in args and args["drink"] is not None:
                target.drink = str(args["drink"])
            if "modifiers" in args and args["modifiers"] is not None:
                target.modifiers = [str(x) for x in args["modifiers"] if str(x).strip()]
            target.unit_price = self._compute_unit_price(entry, target.size, target.meal)
            return {"ok": True, "updated": target.to_dict(), "order": self.snapshot()}

        if name == "remove_item":
            idx = int(args.get("line", 0)) - 1
            if idx < 0 or idx >= len(self.lines):
                return {"ok": False, "error": f"Line {idx + 1} does not exist."}
            removed = self.lines.pop(idx)
            for i, line_obj in enumerate(self.lines, start=1):
                line_obj.line = i
            return {"ok": True, "removed": removed.name, "order": self.snapshot()}

        if name == "get_order":
            return {"ok": True, "order": self.snapshot()}

        if name == "confirm_order":
            if not self.lines:
                return {"ok": False, "error": "Cannot confirm an empty order."}
            self.status = "confirmed"
            return {"ok": True, "confirmed": True, "window": "first window", "order": self.snapshot()}

        if name == "cancel_order":
            self.lines.clear()
            self.status = "cancelled"
            return {"ok": True, "cancelled": True, "order": self.snapshot()}

        return {"ok": False, "error": f"Unknown tool {name!r}"}
