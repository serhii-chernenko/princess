module.exports = ctx => {
    return !!ctx.message?.forward_from && !!ctx.message?.reply_to_message;
};
