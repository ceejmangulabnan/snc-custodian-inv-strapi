import type { Schema, Struct } from '@strapi/strapi'

export interface InventoryLineItem extends Struct.ComponentSchema {
    collectionName: 'components_inventory_line_items'
    info: {
        displayName: 'LineItem'
    }
    attributes: {
        item: Schema.Attribute.Relation<'oneToOne', 'api::item.item'>
        lineTotal: Schema.Attribute.Decimal
        qtyPulled: Schema.Attribute.Integer &
            Schema.Attribute.Required &
            Schema.Attribute.SetMinMax<
                {
                    min: 1
                },
                number
            >
        unitPrice: Schema.Attribute.Decimal
    }
}

declare module '@strapi/strapi' {
    export namespace Public {
        export interface ComponentSchemas {
            'inventory.line-item': InventoryLineItem
        }
    }
}
