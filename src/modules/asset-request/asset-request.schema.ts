import {t} from 'elysia';
import { paginationQuery } from '../../common/pagination';

export const createDraftBody = t.Object({
    poNumber: t.String({minLength:1, maxLength:50}),
    createBy: t.String({minLength:1,maxLength:50})
})
export const requestIdParams = t.Object({id: t.Numeric()})

export const listQuery = t.Composite([ paginationQuery,t.Object({
    status: t.Optional(t.Union([t.Literal('DRAFT'),
        t.Literal('PENDING_APPROVAL'),
        t.Literal('APPROVED'),
        t.Literal('REJECTED'),
        t.Literal('REGISTERED'),
        t.Literal('CANCELLED')
    ],
    )),
    createBy: t.Optional(t.String())
})])
